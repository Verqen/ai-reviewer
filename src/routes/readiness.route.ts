import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { Database } from "~/infrastructure/database/types";

type ReadinessCheckStatus = "error" | "ok";

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

function readinessRoute(
  app: FastifyInstance,
  { db, queue }: ReadinessRouteOptions,
): void {
  app.get("/readiness", async (_req, reply) => {
    let dbStatus: ReadinessCheckStatus = "ok";

    try {
      await sql`SELECT 1`.execute(db);
    } catch {
      dbStatus = "error";
    }

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
