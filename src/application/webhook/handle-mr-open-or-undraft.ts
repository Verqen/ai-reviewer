import { buildCanonicalMrReviewJobKey } from "~/application/review-job-key";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";

import { ensureBaseline } from "./ensure-baseline";
import type {
  WebhookOrchestrationResult,
  WebhookOrchestratorDeps,
} from "./webhook-orchestration.types";

async function handleMrOpenOrUndraft(
  deps: WebhookOrchestratorDeps,
  event: Extract<WebhookEvent, { type: "mr_open" } | { type: "mr_undraft" }>,
): Promise<WebhookOrchestrationResult> {
  const triggerType =
    event.type === "mr_open" ? ("mr_open" as const) : ("mr_undraft" as const);
  const cacheKey = `review:${event.projectId}:${event.mrIid}:${event.headSha}`;
  if (deps.cache.has(cacheKey)) {
    deps.log.info(
      { cacheKey, mrIid: event.mrIid, projectId: event.projectId },
      "Memory cache hit; enqueuing anyway for orchestrator dedup",
    );
  }
  await ensureBaseline(
    event.projectId,
    deps.snapshotRepo,
    deps.queue,
    deps.jobHandler,
  );
  const reviewKey = buildCanonicalMrReviewJobKey(event.projectId, event.mrIid);
  if (deps.queue.isPending(reviewKey)) {
    return { kind: "conflict", reason: "review_in_progress" };
  }
  const job: ReviewJob = {
    mrIid: event.mrIid,
    projectId: event.projectId,
    triggerType,
    type: "full_review",
  };
  const enqueued = deps.queue.enqueue(reviewKey, job, deps.jobHandler);
  if (!enqueued) {
    return { kind: "conflict", reason: "review_in_progress" };
  }
  return { kind: "accepted" };
}

export { handleMrOpenOrUndraft };
