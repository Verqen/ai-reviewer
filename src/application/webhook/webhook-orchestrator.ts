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

function dispatchEvent(
  deps: WebhookOrchestratorDeps,
  event: WebhookEvent,
): Promise<WebhookOrchestrationResult> {
  switch (event.type) {
    case "mr_open":
    case "mr_undraft":
      return handleMrOpenOrUndraft(deps, event);

    case "mr_update":
      return handleMrUpdate(deps, event);

    case "note":
      return handleNote(deps, event);

    case "push":
      return handleDefaultBranchPush(deps, event);

    default: {
      const unhandledEvent: never = event;
      deps.log.error({ event: unhandledEvent }, "Unhandled webhook event type");
      return Promise.resolve({ kind: "ignored" });
    }
  }
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
    const result = await dispatchEvent(deps, event);
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
