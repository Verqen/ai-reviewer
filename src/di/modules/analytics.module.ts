import type { FastifyBaseLogger } from "fastify";
import { createInjector } from "typed-inject";

import { ReviewLearningService } from "~/application/review-learning.service";
import { ThreadManagerService } from "~/application/thread-manager.service";
import type { LlmConfigSchema } from "~/config/llm.config";
import type { OpenRouterConfigSchema } from "~/config/openrouter.config";
import type { PipelineConfigSchema } from "~/config/pipeline.config";
import { resolveDefaultLlmModel } from "~/config/resolve-default-llm-model";
import { AnalyticsTokens } from "~/di/analytics.tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewService } from "~/review/review.service";
import type { IConfig } from "~/shared/config";

interface AnalyticsInfraRepoPorts {
  dismissedPatternRepo: IDismissedPatternRepository;
  reviewFindingRepo: IReviewFindingRepository;
}

class AnalyticsModule {
  static inject = [
    InjectionTokens.Logger,
    InjectionTokens.InfraRepoPorts,
    InjectionTokens.Llm,
    InjectionTokens.CodeHost,
    ReviewTokens.ReviewService,
    InjectionTokens.PipelineConfig,
    InjectionTokens.LlmConfig,
    InjectionTokens.OpenRouterConfig,
  ] as const;

  constructor(
    logger: FastifyBaseLogger,
    infraRepoPorts: AnalyticsInfraRepoPorts,
    llm: ILlmClient,
    codeHost: ICodeHost,
    reviewService: ReviewService,
    pipelineConfig: IConfig<PipelineConfigSchema>,
    llmConfig: IConfig<LlmConfigSchema>,
    openRouterConfig: IConfig<OpenRouterConfigSchema>,
    private readonly injector = createInjector()
      .provideValue(InjectionTokens.Logger, logger)
      .provideValue(InjectionTokens.Llm, llm)
      .provideValue(InjectionTokens.CodeHost, codeHost)
      .provideValue(ReviewTokens.ReviewService, reviewService)
      .provideValue(
        AnalyticsTokens.DismissedPatternRepository,
        infraRepoPorts.dismissedPatternRepo,
      )
      .provideValue(
        AnalyticsTokens.ReviewFindingRepository,
        infraRepoPorts.reviewFindingRepo,
      )
      .provideValue(
        AnalyticsTokens.MaxCostUsd,
        pipelineConfig.envs.REVIEW_MAX_COST_USD,
      )
      .provideValue(
        AnalyticsTokens.CostModel,
        resolveDefaultLlmModel(llmConfig, openRouterConfig),
      )
      .provideClass(
        AnalyticsTokens.ReviewLearningService,
        ReviewLearningService,
      )
      .provideClass(AnalyticsTokens.ThreadManagerService, ThreadManagerService),
  ) {}

  get threadManagerService(): ThreadManagerService {
    return this.injector.resolve(AnalyticsTokens.ThreadManagerService);
  }
}

export { AnalyticsModule };
