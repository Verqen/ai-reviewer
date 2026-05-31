import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";

import type {
  WebhookOrchestrationResult,
  WebhookOrchestratorDeps,
} from "./webhook-orchestration.types";

async function handleDefaultBranchPush(
  deps: WebhookOrchestratorDeps,
  event: Extract<WebhookEvent, { type: "push" }>
): Promise<WebhookOrchestrationResult> {
  const { afterSha, commits, projectId, ref } = event;
  const branchFromRef = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  let defaultBranch: string;
  try {
    defaultBranch = await deps.codeHost.getDefaultBranch(projectId);
  } catch {
    return { kind: "ignored" };
  }
  if (branchFromRef !== defaultBranch) {
    return { kind: "ignored" };
  }
  const changedFiles = [
    ...new Set(
      commits.flatMap((c) => [...c.added, ...c.modified, ...c.removed])
    ),
  ];
  const baselineKey = `update_baseline:${projectId}`;
  if (!deps.queue.isPending(baselineKey)) {
    const baselineJob: ReviewJob = {
      changedFiles,
      commitSha: afterSha,
      defaultBranch,
      projectId,
      type: "update_baseline",
    };
    deps.queue.enqueue(baselineKey, baselineJob, deps.jobHandler);
  }
  return { kind: "accepted" };
}

export { handleDefaultBranchPush };
