import { createHash, timingSafeEqual } from "node:crypto";

import type { IConfig } from "~/shared/config";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BaselineService } from "~/application/baseline.service";
import type { IncrementalReviewService } from "~/application/incremental-review.service";
import { createJobHandler } from "~/application/job-handler";
import type { MainPushReviewService } from "~/application/main-push-review.service";
import type { ThreadManagerService } from "~/application/thread-manager.service";
import type { WebhookOrchestrationResult } from "~/application/webhook/webhook-orchestration.types";
import { createWebhookOrchestrator } from "~/application/webhook/webhook-orchestrator";
import type { GitLabConfigSchema } from "~/config/gitlab.config";
import type { WebhookConfigSchema } from "~/config/webhook.config";
import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { ReviewJob } from "~/domain/types/job.types";
import { parseGitLabWebhook } from "~/infrastructure/code-host/gitlab/gitlab.webhook-adapter";
import type { IReviewService } from "~/review/review.types";

interface WebhookRouteOptions {
  baselineService: BaselineService;
  cache: ICache<boolean>;
  codeHost: ICodeHost;
  gitlabConfig: IConfig<GitLabConfigSchema>;
  incrementalReviewService: IncrementalReviewService;
  mainPushReviewService?: MainPushReviewService | undefined;
  queue: IJobQueue<ReviewJob>;
  reviewer: IReviewService;
  reviewFindingRepo: IReviewFindingRepository;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
  threadManagerService?: ThreadManagerService | undefined;
  webhookConfig: IConfig<WebhookConfigSchema>;
}

function hashValue(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function verifySecret(
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string") {
    return false;
  }
  return timingSafeEqual(hashValue(header), hashValue(secret));
}

function sendOrchestrationResult(
  reply: FastifyReply,
  result: WebhookOrchestrationResult,
): FastifyReply {
  if (result.kind === "accepted") {
    return reply.status(202).send({ status: "accepted" });
  }
  if (result.kind === "ignored") {
    return reply.status(200).send({ status: "ignored" });
  }
  if (result.reason === "review_in_progress") {
    return reply.status(409).send({ error: "Review already in progress" });
  }
  return reply.status(409).send({ error: "Response already in progress" });
}

function webhookRoute(
  app: FastifyInstance,
  {
    baselineService,
    cache,
    codeHost,
    gitlabConfig,
    incrementalReviewService,
    mainPushReviewService,
    queue,
    reviewer,
    reviewFindingRepo,
    reviewRunRepo,
    snapshotRepo,
    threadManagerService,
    webhookConfig,
  }: WebhookRouteOptions,
): void {
  const jobHandler = createJobHandler(reviewer, app.log, {
    baselineService,
    incrementalReviewService,
    mainPushReviewService,
    queue,
    threadManagerService,
  });
  const orchestrator = createWebhookOrchestrator({
    cache,
    codeHost,
    gitlabConfig,
    jobHandler,
    log: app.log,
    queue,
    reviewFindingRepo,
    reviewRunRepo,
    snapshotRepo,
  });
  app.post("/webhook", async (req: FastifyRequest, reply: FastifyReply) => {
    const webhookSecret = webhookConfig.envs.WEBHOOK_SECRET;
    if (webhookSecret) {
      if (!verifySecret(req.headers["x-gitlab-token"], webhookSecret)) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
    const parsed = parseGitLabWebhook(req.body);
    if (parsed.kind === "invalid") {
      return reply.status(400).send({ error: "Invalid payload" });
    }
    if (parsed.kind === "ignored") {
      return reply.status(200).send({ status: "ignored" });
    }
    const event = parsed.event;
    const maxQueueSize = webhookConfig.envs.WEBHOOK_MAX_QUEUE_SIZE;
    if (queue.size >= maxQueueSize) {
      return reply.status(503).send({ error: "Queue is full" });
    }
    const result = await orchestrator.handleEvent(event);
    return sendOrchestrationResult(reply, result);
  });
}

export { webhookRoute };
