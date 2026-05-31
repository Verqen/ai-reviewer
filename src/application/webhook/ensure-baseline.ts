import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { ReviewJob } from "~/domain/types/job.types";

async function ensureBaseline(
  projectId: number,
  snapshotRepo: ISnapshotRepository,
  queue: IJobQueue<ReviewJob>,
  jobHandler: (job: ReviewJob) => Promise<void>
): Promise<void> {
  const baseline = await snapshotRepo.getBaselineState(projectId);
  if (baseline?.status === "ready") {
    return;
  }
  const bootstrapKey = `bootstrap_baseline:${projectId}`;
  if (!queue.isPending(bootstrapKey)) {
    queue.enqueue(
      bootstrapKey,
      { projectId, type: "bootstrap_baseline" },
      jobHandler
    );
  }
}

export { ensureBaseline };
