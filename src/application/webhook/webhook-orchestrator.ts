import type { WebhookEvent } from "~/domain/types/code-host.types";

import { handleDefaultBranchPush } from "./handle-default-branch-push";
import { handleMrOpenOrUndraft } from "./handle-mr-open-or-undraft";
import { handleMrUpdate } from "./handle-mr-update";
import { handleNote } from "./handle-note";
import type {
  WebhookOrchestrationResult,
  WebhookOrchestrator,
  WebhookOrchestratorDeps,
} from "./webhook-orchestration.types";

function buildEventTelemetry(event: WebhookEvent): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  if ("projectId" in event) base["projectId"] = event.projectId;
  if ("mrIid" in event) base["mrIid"] = event.mrIid;
  if ("headSha" in event) base["headSha"] = event.headSha;
  if ("ref" in event) base["ref"] = event.ref;
  return base;
}

function createWebhookOrchestrator(
  deps: WebhookOrchestratorDeps,
): WebhookOrchestrator {
  const handleEvent = async (
    event: WebhookEvent,
  ): Promise<WebhookOrchestrationResult> => {
    const startedAt = Date.now();
    const eventMeta = buildEventTelemetry(event);
    deps.log.info(eventMeta, "Webhook event received");
    let result: WebhookOrchestrationResult;
    if (event.type === "mr_open" || event.type === "mr_undraft") {
      result = await handleMrOpenOrUndraft(deps, event);
    } else if (event.type === "mr_update") {
      result = await handleMrUpdate(deps, event);
    } else if (event.type === "note") {
      result = await handleNote(deps, event);
    } else if (event.type === "push") {
      result = await handleDefaultBranchPush(deps, event);
    } else {
      result = { kind: "ignored" };
    }
    deps.log.info(
      {
        ...eventMeta,
        durationMs: Date.now() - startedAt,
        outcome: result.kind,
        reason: "reason" in result ? result.reason : undefined,
      },
      "Webhook event processed",
    );
    return result;
  };
  return { handleEvent };
}

export { createWebhookOrchestrator };
