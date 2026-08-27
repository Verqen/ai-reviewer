import type { FastifyBaseLogger } from "fastify";
import { createInjector } from "typed-inject";

import { CommentResolutionService } from "~/application/comment-resolution.service";
import { ForcePushCorrelationService } from "~/application/force-push-correlation.service";
import { IncrementalReviewService } from "~/application/incremental-review.service";
import { ReviewConfigLoader } from "~/application/review-config.loader";
import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import { ReviewHistoryService } from "~/application/review-history.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { LlmConfig } from "~/config/llm.config";
import type { OpenRouterConfig } from "~/config/openrouter.config";
import type { PipelineConfig } from "~/config/pipeline.config";
import { InfraPortsTokens } from "~/di/infra-ports-tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IDocProvider } from "~/domain/ports/doc-provider.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IPipelineMetrics } from "~/domain/ports/pipeline-metrics.port";
import type { IReviewPass } from "~/domain/types/pipeline.types";
import type { TokenBucket } from "~/infrastructure/rate-limiter/token-bucket";
import { AggregationPass } from "~/pipeline/passes/aggregation.pass";
import { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
import { FileReviewPass } from "~/pipeline/passes/file-review.pass";
import { TriagePass } from "~/pipeline/passes/triage.pass";
import { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { ReviewService } from "~/review/review.service";

class ReviewModule {
  static inject = [
    InjectionTokens.Logger,
    InjectionTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    InjectionTokens.Llm,
    InjectionTokens.DocProvider,
    InjectionTokens.Cache,
    InjectionTokens.RateLimiter,
    InjectionTokens.PipelineConfig,
    InjectionTokens.LlmConfig,
    InjectionTokens.OpenRouterConfig,
    InjectionTokens.PipelineMetrics,
  ] as const;

  constructor(
    logger: FastifyBaseLogger,
    infraRepoPorts: ReviewInfraRepoPorts,
    codeHost: ICodeHost,
    llm: ILlmClient,
    docProvider: IDocProvider,
    cache: ICache<boolean>,
    rateLimiter: TokenBucket,
    pipelineConfig: PipelineConfig,
    llmConfig: LlmConfig,
    openRouterConfig: OpenRouterConfig,
    pipelineMetrics: IPipelineMetrics,
    private readonly injector = createInjector()
      .provideValue(InjectionTokens.Logger, logger)
      .provideValue(ReviewTokens.InfraRepoPorts, infraRepoPorts)
      .provideValue(InjectionTokens.CodeHost, codeHost)
      .provideValue(InjectionTokens.Llm, llm)
      .provideValue(InjectionTokens.Cache, cache)
      .provideValue(InjectionTokens.PipelineConfig, pipelineConfig)
      .provideValue(InjectionTokens.LlmConfig, llmConfig)
      .provideValue(InjectionTokens.OpenRouterConfig, openRouterConfig)
      .provideValue(InjectionTokens.PipelineMetrics, pipelineMetrics)
      .provideValue(InfraPortsTokens.SnapshotRepo, infraRepoPorts.snapshotRepo)
      .provideValue(
        ReviewTokens.ReviewPasses,
        buildPasses(
          llm,
          logger,
          infraRepoPorts.dismissedPatternRepo,
          {
            crossFile: pipelineConfig.envs.REVIEW_CROSS_FILE_PROMPT_HARD_LIMIT,
            fileReview: pipelineConfig.envs.REVIEW_FILE_PROMPT_HARD_LIMIT,
            triage: pipelineConfig.envs.REVIEW_TRIAGE_PROMPT_HARD_LIMIT,
          },
          pipelineConfig.envs.LINE_SHIFT_DEDUP_TOLERANCE,
          pipelineConfig.envs.FILE_REVIEW_MAX_DIFF_CHARACTERS,
          docProvider,
          rateLimiter,
          pipelineMetrics,
        ),
      )
      .provideValue(
        ReviewTokens.ReviewConfigLoader,
        new ReviewConfigLoader(codeHost, logger),
      )
      .provideValue(
        ReviewTokens.ReviewHistoryService,
        new ReviewHistoryService(infraRepoPorts.reviewFindingRepo),
      )
      .provideValue(
        ReviewTokens.CommentResolutionService,
        new CommentResolutionService(
          infraRepoPorts.reviewFindingRepo,
          codeHost,
          logger,
        ),
      )
      .provideClass(
        ReviewTokens.ReviewRunLifecycleService,
        ReviewRunLifecycleService,
      )
      .provideClass(
        ReviewTokens.ReviewContextBuilderService,
        ReviewContextBuilderService,
      )
      .provideClass(
        ReviewTokens.ReviewFindingPublisherService,
        ReviewFindingPublisherService,
      )
      .provideClass(
        ReviewTokens.ReviewRunCompletionService,
        ReviewRunCompletionService,
      )
      .provideClass(ReviewTokens.PipelineOrchestrator, PipelineOrchestrator)
      .provideClass(ReviewTokens.ReviewService, ReviewService)
      .provideClass(
        ReviewTokens.ForcePushCorrelationService,
        ForcePushCorrelationService,
      )
      .provideClass(
        ReviewTokens.IncrementalReviewService,
        IncrementalReviewService,
      ),
  ) {}

  get reviewService(): ReviewService {
    return this.injector.resolve(ReviewTokens.ReviewService);
  }

  get incrementalReviewService(): IncrementalReviewService {
    return this.injector.resolve(ReviewTokens.IncrementalReviewService);
  }
}

interface PromptHardLimits {
  crossFile: number;
  fileReview: number;
  triage: number;
}

function buildPasses(
  llm: ILlmClient,
  logger: FastifyBaseLogger,
  dismissedPatternRepo: IDismissedPatternRepository,
  promptHardLimits: PromptHardLimits,
  lineShiftDedupTolerance: number,
  fileReviewMaxDiffCharacters: number,
  docProvider?: IDocProvider,
  rateLimiter?: TokenBucket,
  pipelineMetrics?: IPipelineMetrics,
): IReviewPass[] {
  return [
    new TriagePass(llm, logger, promptHardLimits.triage, pipelineMetrics),
    new FileReviewPass(
      llm,
      logger,
      docProvider,
      rateLimiter,
      promptHardLimits.fileReview,
      fileReviewMaxDiffCharacters,
    ),
    new CrossFilePass(llm, logger, promptHardLimits.crossFile),
    new AggregationPass(dismissedPatternRepo, logger, lineShiftDedupTolerance),
  ];
}

export { ReviewModule };
