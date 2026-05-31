import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { Database } from "~/infrastructure/database/types";

type HealthCheckStatus = "error" | "ok";

interface HealthResponse {
  activeJobs: number;
  checks: {
    database: HealthCheckStatus;
  };
  queueDepth: number;
  status: "ok" | "unhealthy";
}

interface HealthRouteOptions {
  db: Kysely<Database>;
  queue: IJobQueue<ReviewJob>;
}

function healthRoute(
  app: FastifyInstance,
  { db, queue }: HealthRouteOptions,
): void {
  app.get("/health", async (_req, reply) => {
    let dbStatus: HealthCheckStatus = "ok";

    try {
      await sql`SELECT 1`.execute(db);
    } catch {
      dbStatus = "error";
    }

    const payload: HealthResponse = {
      activeJobs: queue.activeCount,
      checks: { database: dbStatus },
      queueDepth: queue.size,
      status: dbStatus === "ok" ? "ok" : "unhealthy",
    };

    return reply.status(dbStatus === "ok" ? 200 : 503).send(payload);
  });
}

export { healthRoute };
