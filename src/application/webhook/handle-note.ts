import { buildCanonicalMrReviewJobKey } from "~/application/review-job-key";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";
import type { CommentContext } from "~/domain/types/review.types";

import { isBotMentioned, isReviewRequest } from "./note-text-guards";
import type {
  WebhookOrchestrationResult,
  WebhookOrchestratorDeps,
} from "./webhook-orchestration.types";

async function handleNote(
  deps: WebhookOrchestratorDeps,
  event: Extract<WebhookEvent, { type: "note" }>,
): Promise<WebhookOrchestrationResult> {
  const botUsername = deps.gitlabConfig.envs.GITLAB_BOT_USERNAME;
  if (event.authorUsername === botUsername) {
    return { kind: "ignored" };
  }
  if (event.discussionId) {
    const findings = await deps.reviewFindingRepo.findByProjectAndMr(
      event.projectId,
      event.mrIid,
    );
    const isBotDiscussion = findings.some(
      (f) => f.hostDiscussionId === event.discussionId,
    );
    if (isBotDiscussion) {
      if (!isBotMentioned(event.note, botUsername)) {
        return { kind: "ignored" };
      }
      const threadKey = `thread_response:${event.projectId}:${event.mrIid}:${event.discussionId}`;
      if (deps.queue.isPending(threadKey)) {
        return { kind: "conflict", reason: "response_in_progress" };
      }
      const threadJob: ReviewJob = {
        authorUsername: event.authorUsername,
        discussionId: event.discussionId,
        mrIid: event.mrIid,
        noteBody: event.note,
        projectId: event.projectId,
        type: "thread_response",
      };
      const enqueued = deps.queue.enqueue(
        threadKey,
        threadJob,
        deps.jobHandler,
      );
      if (!enqueued) {
        return { kind: "conflict", reason: "response_in_progress" };
      }
      return { kind: "accepted" };
    }
  }
  if (!isBotMentioned(event.note, botUsername)) {
    return { kind: "ignored" };
  }
  if (isReviewRequest(event.note)) {
    const reviewKey = buildCanonicalMrReviewJobKey(
      event.projectId,
      event.mrIid,
    );
    const reviewJob: ReviewJob = {
      mrIid: event.mrIid,
      projectId: event.projectId,
      triggerType: "mention",
      type: "full_review",
    };
    const enqueued = deps.queue.enqueue(reviewKey, reviewJob, deps.jobHandler);
    if (!enqueued) {
      return { kind: "conflict", reason: "review_in_progress" };
    }
    return { kind: "accepted" };
  }
  const context: CommentContext = {
    discussionId: event.discussionId,
    newLine: event.position?.newLine,
    newPath: event.position?.newPath,
    note: event.note,
    oldLine: event.position?.oldLine,
    oldPath: event.position?.oldPath,
  };
  const noteKey = `comment_response:${event.projectId}:${event.mrIid}:${context.discussionId ?? "general"}`;
  if (deps.queue.isPending(noteKey)) {
    return { kind: "conflict", reason: "response_in_progress" };
  }
  const commentJob: ReviewJob = {
    context,
    mrIid: event.mrIid,
    projectId: event.projectId,
    type: "comment_response",
  };
  const enqueued = deps.queue.enqueue(noteKey, commentJob, deps.jobHandler);
  if (!enqueued) {
    return { kind: "conflict", reason: "response_in_progress" };
  }
  return { kind: "accepted" };
}

export { handleNote };
