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
import { readinessRoute } from "~/routes/readiness.route";
import { webhookRoute } from "~/routes/webhook.route";

const appConfig = new AppConfig();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: { level: appConfig.envs.LOG_LEVEL },
});

const {
  appInjector,
  botUsername,
  codeHostProvider,
  db,
  metricsRegistry,
  queue,
} = buildDiContainer(fastify.log);

queue.onError((key, err, retriesLeft) => {
  fastify.log.error({ err, key, retriesLeft }, "Job failed");
});

const webhookConfig = appInjector.resolve(InjectionTokens.WebhookConfig);

const cache = appInjector.resolve(InjectionTokens.Cache);

const codeHost = appInjector.resolve(InjectionTokens.CodeHost);

const infraRepoPorts = appInjector.resolve(InjectionTokens.InfraRepoPorts);

const reviewModule = appInjector.resolve(InjectionTokens.ReviewModule);

const analyticsModule = appInjector.resolve(InjectionTokens.AnalyticsModule);

const pipelineConfig = appInjector.resolve(InjectionTokens.PipelineConfig);

if (!webhookConfig.envs.WEBHOOK_SIGNATURE_REQUIRED) {
  fastify.log.warn(
    "WEBHOOK_SIGNATURE_REQUIRED=false, webhook signatures are not verified",
  );
}

const application = new Application(fastify, appConfig, queue, async () => {
  await db.destroy();
});

fastify.register(healthRoute);
fastify.register(readinessRoute, { db, queue });

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
  },
);
const mainPushReviewService = new MainPushReviewService(
  infraRepoPorts,
  codeHost,
  queue,
  fastify.log,
);

fastify.register(webhookRoute, {
  baselineService,
  botUsername,
  cache,
  codeHost,
  codeHostProvider,
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
