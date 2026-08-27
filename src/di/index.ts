import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type { Registry } from "prom-client";
import { createInjector } from "typed-inject";

import { Context7Config } from "~/config/context7.config";
import { DatabaseConfig } from "~/config/database.config";
import { GitHubConfig } from "~/config/github.config";
import { GitLabConfig } from "~/config/gitlab.config";
import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import { PipelineConfig } from "~/config/pipeline.config";
import { readRuntimeEnv } from "~/config/runtime.env";
import { WebhookConfig } from "~/config/webhook.config";
import { InfraRepoPorts } from "~/di/infra-repo-ports";
import { InjectionTokens } from "~/di/injection-tokens";
import { AnalyticsModule } from "~/di/modules/analytics.module";
import { ReviewModule } from "~/di/modules/review.module";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { CommentContext } from "~/domain/types/review.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import {
  createGitHubOctokit,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import { GitLabCodeHost } from "~/infrastructure/code-host/gitlab/gitlab.code-host";
import { createDatabase } from "~/infrastructure/database/database";
import type { Database } from "~/infrastructure/database/types";
import { Context7Provider } from "~/infrastructure/docs/context7/context7.provider";
import { NoOpDocProvider } from "~/infrastructure/docs/noop-doc-provider";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
import { createMetricsRegistry } from "~/infrastructure/metrics/metrics.registry";
import { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";
import { JobQueue } from "~/infrastructure/queue/job-queue";
import { TokenBucket } from "~/infrastructure/rate-limiter/token-bucket";

function createBootstrapInjector(fastifyLogger: FastifyBaseLogger) {
  return createInjector()
    .provideValue(InjectionTokens.Logger, fastifyLogger)
    .provideClass(InjectionTokens.DatabaseConfig, DatabaseConfig)
    .provideClass(InjectionTokens.OpenRouterConfig, OpenRouterConfig)
    .provideClass(InjectionTokens.WebhookConfig, WebhookConfig)
    .provideClass(InjectionTokens.LlmConfig, LlmConfig)
    .provideClass(InjectionTokens.PipelineConfig, PipelineConfig);
}

function buildDiContainer(fastifyLogger: FastifyBaseLogger) {
  const bootstrapInjector = createBootstrapInjector(fastifyLogger);

  const dbConfig = bootstrapInjector.resolve(InjectionTokens.DatabaseConfig);
  const llmConfig = bootstrapInjector.resolve(InjectionTokens.LlmConfig);
  const openrouterConfig = bootstrapInjector.resolve(
    InjectionTokens.OpenRouterConfig,
  );

  const db: Kysely<Database> = createDatabase(dbConfig.envs.DATABASE_URL);

  const codeHostProvider = readRuntimeEnv().CODE_HOST_PROVIDER;
  let codeHost: ICodeHost;
  let botUsername: string;
  if (codeHostProvider === "github") {
    const githubConfig = new GitHubConfig();
    codeHost = new GitHubCodeHost(
      createGitHubOctokit(githubConfig),
      githubConfig,
      fastifyLogger,
    );
    botUsername = githubConfig.envs.GITHUB_BOT_USERNAME;
  } else {
    const gitlabConfig = new GitLabConfig();
    codeHost = new GitLabCodeHost(gitlabConfig, fastifyLogger);
    botUsername = gitlabConfig.envs.GITLAB_BOT_USERNAME;
  }

  const llmProvider = llmConfig.envs.LLM_PROVIDER;
  const llm =
    llmProvider === "ollama"
      ? new OllamaClient(llmConfig, fastifyLogger)
      : new OpenRouterClient(openrouterConfig, fastifyLogger);

  const cache: ICache<boolean> = new MemoryCache<boolean>();
  const queue = new JobQueue<ReviewJob>();
  const rateLimiter = new TokenBucket(60, 1);
  const metricsRegistry: Registry = createMetricsRegistry();
  const pipelineMetrics = new PipelineMetrics(metricsRegistry);

  let context7Config: Context7Config | null;
  try {
    context7Config = new Context7Config();
  } catch {
    context7Config = null;
  }

  const docProvider = context7Config?.envs.CONTEXT7_ENABLED
    ? new Context7Provider(context7Config, fastifyLogger)
    : new NoOpDocProvider();

  const infraInjector = bootstrapInjector
    .provideValue(InjectionTokens.Database, db)
    .provideValue(InjectionTokens.CodeHost, codeHost)
    .provideValue(InjectionTokens.Llm, llm)
    .provideValue(InjectionTokens.DocProvider, docProvider)
    .provideValue(InjectionTokens.Cache, cache)
    .provideValue(InjectionTokens.RateLimiter, rateLimiter)
    .provideValue(InjectionTokens.MetricsRegistry, metricsRegistry)
    .provideValue(InjectionTokens.PipelineMetrics, pipelineMetrics)
    .provideClass(InjectionTokens.InfraRepoPorts, InfraRepoPorts);

  const reviewInjector = infraInjector.provideClass(
    InjectionTokens.ReviewModule,
    ReviewModule,
  );
  const reviewModule = reviewInjector.resolve(InjectionTokens.ReviewModule);
  const respondToComment = (
    projectId: number,
    mrIid: number,
    context: CommentContext,
  ): Promise<void> =>
    reviewModule.reviewService.respondToComment(projectId, mrIid, context);
  const appInjector = reviewInjector
    .provideValue(ReviewTokens.ReviewService, reviewModule.reviewService)
    .provideValue(InjectionTokens.RespondToComment, respondToComment)
    .provideClass(InjectionTokens.AnalyticsModule, AnalyticsModule);

  return {
    appInjector,
    botUsername,
    codeHostProvider,
    db,
    metricsRegistry,
    queue,
  };
}

export { buildDiContainer };
