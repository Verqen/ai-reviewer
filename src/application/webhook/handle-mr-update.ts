import { buildCanonicalMrReviewJobKey } from "~/application/review-job-key";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";

import { detectIncrementalTrigger } from "./detect-incremental-trigger";
import { ensureBaseline } from "./ensure-baseline";
import type {
  WebhookOrchestrationResult,
  WebhookOrchestratorDeps,
} from "./webhook-orchestration.types";

async function handleMrUpdate(
  deps: WebhookOrchestratorDeps,
  event: Extract<WebhookEvent, { type: "mr_update" }>
): Promise<WebhookOrchestrationResult> {
  const { headSha, mrIid, previousHeadSha, projectId } = event;
  await ensureBaseline(
    projectId,
    deps.snapshotRepo,
    deps.queue,
    deps.jobHandler
  );
  const reviewKey = buildCanonicalMrReviewJobKey(projectId, mrIid);
  if (deps.queue.isPending(reviewKey)) {
    return { kind: "conflict", reason: "review_in_progress" };
  }
  const previousRun = await deps.reviewRunRepo.findLatestByProjectAndMr(
    projectId,
    mrIid,
    undefined,
    { includeFailedForBaseline: true }
  );
  if (!previousRun) {
    const job: ReviewJob = {
      mrIid,
      projectId,
      triggerType: "push",
      type: "full_review",
    };
    const enqueued = deps.queue.enqueue(reviewKey, job, deps.jobHandler);
    if (!enqueued) {
      return { kind: "conflict", reason: "review_in_progress" };
    }
    return { kind: "accepted" };
  }
  const versions = await deps.codeHost.getMergeRequestVersions(
    projectId,
    mrIid
  );
  const hasPreviousBaseSha =
    typeof previousRun.baseCommitSha === "string" &&
    previousRun.baseCommitSha.length > 0;
  const hasBaseDrift =
    hasPreviousBaseSha && previousRun.baseCommitSha !== versions.baseSha;
  const resolvedPreviousSha = previousHeadSha ?? previousRun.headCommitSha;
  const triggerType = hasBaseDrift
    ? "force_push"
    : await detectIncrementalTrigger(
        deps.codeHost,
        projectId,
        resolvedPreviousSha,
        headSha,
        deps.log
      );
  const job: ReviewJob = {
    mrIid,
    newHeadSha: headSha,
    previousSha: resolvedPreviousSha,
    projectId,
    triggerType,
    type: "incremental_review",
  };
  const enqueued = deps.queue.enqueue(reviewKey, job, deps.jobHandler);
  if (!enqueued) {
    return { kind: "conflict", reason: "review_in_progress" };
  }
  return { kind: "accepted" };
}

export { handleMrUpdate };
