import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { Database } from "~/infrastructure/database/types";

type ReadinessCheckStatus = "error" | "ok";

const DATABASE_PROBE_DEADLINE_MS = 2_000;
const ORCHESTRATOR_PROBE_PERIOD_MS = 10_000;
const DATABASE_VERDICT_TTL_MS = ORCHESTRATOR_PROBE_PERIOD_MS / 2;

interface ReadinessResponse {
  activeJobs: number;
  checks: {
    database: ReadinessCheckStatus;
  };
  queueDepth: number;
  status: "ready" | "unready";
}

interface ReadinessRouteOptions {
  db: Kysely<Database>;
  queue: IJobQueue<ReviewJob>;
}

interface CachedDatabaseVerdict {
  expiresAt: number;
  status: ReadinessCheckStatus;
}

interface Deadline {
  cancel: () => void;
  expired: Promise<never>;
}

function startDeadline(timeoutMs: number): Deadline {
  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Readiness database probe exceeded its deadline"));
    }, timeoutMs);
    timer.unref();
  });

  return {
    cancel: (): void => {
      clearTimeout(timer);
    },
    expired,
  };
}

function readinessRoute(
  app: FastifyInstance,
  { db, queue }: ReadinessRouteOptions,
): void {
  let cachedVerdict: CachedDatabaseVerdict | null = null;
  let probeInFlight: Promise<ReadinessCheckStatus> | null = null;

  const runDatabaseProbe = async (
    log: FastifyBaseLogger,
  ): Promise<ReadinessCheckStatus> => {
    const deadline = startDeadline(DATABASE_PROBE_DEADLINE_MS);
    let status: ReadinessCheckStatus = "ok";

    try {
      await Promise.race([sql`SELECT 1`.execute(db), deadline.expired]);
    } catch (err: unknown) {
      log.warn({ err }, "Readiness database probe failed");
      status = "error";
    } finally {
      deadline.cancel();
    }

    cachedVerdict = {
      expiresAt: Date.now() + DATABASE_VERDICT_TTL_MS,
      status,
    };

    return status;
  };

  const checkDatabase = async (
    log: FastifyBaseLogger,
  ): Promise<ReadinessCheckStatus> => {
    if (cachedVerdict !== null && cachedVerdict.expiresAt > Date.now()) {
      return cachedVerdict.status;
    }

    probeInFlight ??= runDatabaseProbe(log).finally(() => {
      probeInFlight = null;
    });

    return probeInFlight;
  };

  app.get("/readiness", async (req, reply) => {
    const dbStatus = await checkDatabase(req.log);

    const payload: ReadinessResponse = {
      activeJobs: queue.activeCount,
      checks: { database: dbStatus },
      queueDepth: queue.size,
      status: dbStatus === "ok" ? "ready" : "unready",
    };

    return reply.status(dbStatus === "ok" ? 200 : 503).send(payload);
  });
}

export { readinessRoute };
