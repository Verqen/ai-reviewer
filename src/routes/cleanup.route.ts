import type { IConfig } from "~/shared/config";
import type { FastifyInstance } from "fastify";

import type { AppConfigSchema } from "~/config/app.config";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import { bearerToken, secretsMatch } from "~/shared/secret-compare";

const MILLISECONDS_PER_DAY = 86_400_000;

interface CleanupRouteOptions {
  appConfig: IConfig<AppConfigSchema>;
  cleanupToken: string;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
}

function cleanupRoute(
  app: FastifyInstance,
  { appConfig, cleanupToken, reviewRunRepo, snapshotRepo }: CleanupRouteOptions,
): void {
  app.post("/cleanup", async (req, reply) => {
    if (!secretsMatch(bearerToken(req.headers.authorization), cleanupToken)) {
      req.log.warn("Rejected unauthorized cleanup request");
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const nowMs = Date.now();
    const retentionDays = appConfig.envs.CLEANUP_RETENTION_DAYS;
    const cutoff = new Date(nowMs - retentionDays * MILLISECONDS_PER_DAY);
    const deletedReviewRuns =
      await reviewRunRepo.deleteCompletedOrFailedBefore(cutoff);
    const deletedSnapshots =
      await snapshotRepo.deleteOldSnapshotsBefore(cutoff);

    req.log.info(
      {
        cutoff: cutoff.toISOString(),
        deletedReviewRuns,
        deletedSnapshots,
        retentionDays,
      },
      "Cleanup completed",
    );

    return reply.status(200).send({
      cutoff: cutoff.toISOString(),
      deletedReviewRuns,
      deletedSnapshots,
    });
  });
}

export { cleanupRoute };
