import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import { PipelineConfig } from "~/config/pipeline.config";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";

import { createMockCodeHost } from "./mock-code-host";
import { createMockCommentResolutionService } from "./mock-comment-resolution-service";
import { createMockInfraRepoPorts } from "./mock-infra-repo-ports";
import {
  createMockLlmConfig,
  createMockOpenRouterConfig,
} from "./mock-llm-config";
import { createMockLogger } from "./mock-logger";
import { createMockPipelineMetrics } from "./mock-pipeline-metrics";
import { createMockReviewConfigLoader } from "./mock-review-config-loader";
import { createMockReviewHistoryService } from "./mock-review-history-service";

function createMockPipelineOrchestrator(
  overrides: Partial<PipelineOrchestrator> = {},
): PipelineOrchestrator {
  const infraRepoPorts = createMockInfraRepoPorts();
  const codeHost = createMockCodeHost();
  const logger = createMockLogger();
  const pipelineConfig = new PipelineConfig();

  const orchestrator = new PipelineOrchestrator(
    new ReviewRunLifecycleService(infraRepoPorts, logger, pipelineConfig),
    new ReviewContextBuilderService(
      infraRepoPorts,
      codeHost,
      createMockReviewConfigLoader(),
      createMockReviewHistoryService(),
      pipelineConfig,
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      logger,
    ),
    new ReviewFindingPublisherService(
      infraRepoPorts,
      codeHost,
      createMockCommentResolutionService(),
      logger,
    ),
    new ReviewRunCompletionService(
      infraRepoPorts,
      codeHost,
      new MemoryCache<boolean>(),
      logger,
    ),
    [],
    createMockPipelineMetrics(),
    logger,
  );

  return Object.assign(orchestrator, overrides);
}

export { createMockPipelineOrchestrator };
