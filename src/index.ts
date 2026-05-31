import Fastify from "fastify";

import { Application } from "~/application";
import { BaselineService } from "~/application/baseline.service";
import { MainPushReviewService } from "~/application/main-push-review.service";
import { AppConfig } from "~/config/app.config";
import { buildDiContainer } from "~/di/index";
import { InjectionTokens } from "~/di/injection-tokens";
import { cleanupRoute } from "~/routes/cleanup.route";
import { healthRoute } from "~/routes/health.route";
import { metricsRoute } from "~/routes/metrics.route";
import { webhookRoute } from "~/routes/webhook.route";

const appConfig = new AppConfig();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: { level: appConfig.envs.LOG_LEVEL },
});

const { appInjector, db, metricsRegistry, queue } = buildDiContainer(
  fastify.log
);

queue.onError((key, err, retriesLeft) => {
  fastify.log.error({ err, key, retriesLeft }, "Job failed");
});

const webhookConfig = appInjector.resolve(InjectionTokens.WebhookConfig);

const gitlabConfig = appInjector.resolve(InjectionTokens.GitLabConfig);

const cache = appInjector.resolve(InjectionTokens.Cache);

const codeHost = appInjector.resolve(InjectionTokens.CodeHost);

const infraRepoPorts = appInjector.resolve(InjectionTokens.InfraRepoPorts);

const reviewModule = appInjector.resolve(InjectionTokens.ReviewModule);

const analyticsModule = appInjector.resolve(InjectionTokens.AnalyticsModule);

const pipelineConfig = appInjector.resolve(InjectionTokens.PipelineConfig);

if (!webhookConfig.envs.WEBHOOK_SECRET) {
  fastify.log.warn(
    "WEBHOOK_SECRET is not set, webhook endpoint is unauthenticated"
  );
}

const application = new Application(fastify, appConfig, queue);

fastify.register(healthRoute, { db, queue });

fastify.register(metricsRoute, { registry: metricsRegistry });

fastify.register(cleanupRoute, {
  appConfig,
  reviewRunRepo: infraRepoPorts.reviewRunRepo,
  snapshotRepo: infraRepoPorts.snapshotRepo,
});

const baselineService = new BaselineService(
  infraRepoPorts.snapshotRepo,
  codeHost,
  fastify.log,
  {
    pollMs: pipelineConfig.envs.REVIEW_BASELINE_POLL_MS,
    timeoutMs: pipelineConfig.envs.REVIEW_BASELINE_READY_TIMEOUT_MS,
  }
);
const mainPushReviewService = new MainPushReviewService(
  infraRepoPorts,
  codeHost,
  queue,
  fastify.log
);

fastify.register(webhookRoute, {
  baselineService,
  cache,
  codeHost,
  gitlabConfig,
  incrementalReviewService: reviewModule.incrementalReviewService,
  mainPushReviewService,
  queue,
  reviewer: reviewModule.reviewService,
  reviewFindingRepo: infraRepoPorts.reviewFindingRepo,
  reviewRunRepo: infraRepoPorts.reviewRunRepo,
  snapshotRepo: infraRepoPorts.snapshotRepo,
  threadManagerService: analyticsModule.threadManagerService,
  webhookConfig,
});

async function start(): Promise<void> {
  try {
    await application.init();
  } catch (err) {
    fastify.log.fatal(err);
    process.exit(1);
  }
}

void start();
