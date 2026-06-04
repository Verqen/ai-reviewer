import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { IConfig } from "~/shared/config";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BaselineService } from "~/application/baseline.service";
import type { IncrementalReviewService } from "~/application/incremental-review.service";
import { createJobHandler } from "~/application/job-handler";
import type { MainPushReviewService } from "~/application/main-push-review.service";
import type { ThreadManagerService } from "~/application/thread-manager.service";
import type { WebhookOrchestrationResult } from "~/application/webhook/webhook-orchestration.types";
import { createWebhookOrchestrator } from "~/application/webhook/webhook-orchestrator";
import type { WebhookConfigSchema } from "~/config/webhook.config";
import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";
import { parseGitHubWebhook } from "~/infrastructure/code-host/github/github.webhook-adapter";
import { parseGitLabWebhook } from "~/infrastructure/code-host/gitlab/gitlab.webhook-adapter";
import type { IReviewService } from "~/review/review.types";

type CodeHostProvider = "github" | "gitlab";

const WEBHOOK_BODY_LIMIT_BYTES = 5_242_880;

interface WebhookRouteOptions {
  baselineService: BaselineService;
  botUsername: string;
  cache: ICache<boolean>;
  codeHost: ICodeHost;
  codeHostProvider: CodeHostProvider;
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

function verifyGitHubSignature(
  rawBody: string,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(header);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) {
    return false;
  }
  return timingSafeEqual(provided, computed);
}

const rawBodyByRequest = new WeakMap<FastifyRequest, string>();

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
    botUsername,
    cache,
    codeHost,
    codeHostProvider,
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
    botUsername,
    cache,
    codeHost,
    jobHandler,
    log: app.log,
    queue,
    reviewFindingRepo,
    reviewRunRepo,
    snapshotRepo,
  });

  void app.register((instance, _opts, done) => {
    if (codeHostProvider === "github") {
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (req, body, parserDone) => {
          const raw = typeof body === "string" ? body : body.toString("utf8");
          rawBodyByRequest.set(req, raw);
          try {
            parserDone(
              null,
              raw.length > 0 ? (JSON.parse(raw) as unknown) : {},
            );
          } catch (error) {
            parserDone(
              error instanceof Error ? error : new Error("Invalid JSON"),
              undefined,
            );
          }
        },
      );
    }

    instance.post(
      "/webhook",
      { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const webhookSecret = webhookConfig.envs.WEBHOOK_SECRET;
        const parsed =
          codeHostProvider === "github"
            ? authorizeAndParseGitHub(req, webhookSecret)
            : authorizeAndParseGitLab(req, webhookSecret);

        if (parsed.kind === "unauthorized") {
          return reply.status(401).send({ error: "Unauthorized" });
        }
        if (parsed.kind === "invalid") {
          return reply.status(400).send({ error: "Invalid payload" });
        }
        if (parsed.kind === "ignored") {
          return reply.status(200).send({ status: "ignored" });
        }
        const maxQueueSize = webhookConfig.envs.WEBHOOK_MAX_QUEUE_SIZE;
        if (queue.size >= maxQueueSize) {
          return reply.status(503).send({ error: "Queue is full" });
        }
        const result = await orchestrator.handleEvent(parsed.event);
        return sendOrchestrationResult(reply, result);
      },
    );

    done();
  });
}

type RouteParseResult =
  | { kind: "event"; event: WebhookEvent }
  | { kind: "ignored" }
  | { kind: "invalid" }
  | { kind: "unauthorized" };

function authorizeAndParseGitLab(
  req: FastifyRequest,
  secret: string | undefined,
): RouteParseResult {
  if (secret && !verifySecret(req.headers["x-gitlab-token"], secret)) {
    return { kind: "unauthorized" };
  }
  const parsed = parseGitLabWebhook(req.body);
  if (parsed.kind === "event") {
    return { event: parsed.event, kind: "event" };
  }
  return { kind: parsed.kind === "ignored" ? "ignored" : "invalid" };
}

function authorizeAndParseGitHub(
  req: FastifyRequest,
  secret: string | undefined,
): RouteParseResult {
  if (secret) {
    const raw = rawBodyByRequest.get(req) ?? "";
    if (
      !verifyGitHubSignature(raw, req.headers["x-hub-signature-256"], secret)
    ) {
      return { kind: "unauthorized" };
    }
  }
  const eventName = req.headers["x-github-event"];
  const parsed = parseGitHubWebhook(
    typeof eventName === "string" ? eventName : "",
    req.body,
  );
  if (parsed.kind === "event") {
    return { event: parsed.event, kind: "event" };
  }
  return { kind: parsed.kind === "ignored" ? "ignored" : "invalid" };
}

export { webhookRoute };
