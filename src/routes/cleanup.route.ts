import type { IConfig } from "~/shared/config";
import type { FastifyInstance } from "fastify";

import type { AppConfigSchema } from "~/config/app.config";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

const MILLISECONDS_PER_DAY = 86_400_000;

interface CleanupRouteOptions {
  appConfig: IConfig<AppConfigSchema>;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
}

function cleanupRoute(
  app: FastifyInstance,
  { appConfig, reviewRunRepo, snapshotRepo }: CleanupRouteOptions,
): void {
  app.post("/cleanup", async (_req, reply) => {
    const nowMs = Date.now();
    const retentionDays = appConfig.envs.CLEANUP_RETENTION_DAYS;
    const cutoff = new Date(nowMs - retentionDays * MILLISECONDS_PER_DAY);
    const deletedReviewRuns =
      await reviewRunRepo.deleteCompletedOrFailedBefore(cutoff);
    const deletedSnapshots =
      await snapshotRepo.deleteOldSnapshotsBefore(cutoff);
    return reply.status(200).send({
      cutoff: cutoff.toISOString(),
      deletedReviewRuns,
      deletedSnapshots,
    });
  });
}

export { cleanupRoute };
