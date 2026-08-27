import { ForcePushCorrelationService } from "~/application/force-push-correlation.service";
import { IncrementalReviewService } from "~/application/incremental-review.service";
import { PipelineConfig } from "~/config/pipeline.config";

import { createMockCodeHost } from "./mock-code-host";
import { createMockInfraRepoPorts } from "./mock-infra-repo-ports";
import { createMockLogger } from "./mock-logger";
import { createMockPipelineMetrics } from "./mock-pipeline-metrics";
import { createMockPipelineOrchestrator } from "./mock-pipeline-orchestrator";

function createMockIncrementalReviewService(
  overrides: Partial<IncrementalReviewService> = {},
): IncrementalReviewService {
  const infraRepoPorts = createMockInfraRepoPorts();
  const codeHost = createMockCodeHost();
  const logger = createMockLogger();

  const service = new IncrementalReviewService(
    infraRepoPorts,
    codeHost,
    createMockPipelineOrchestrator(),
    logger,
    new ForcePushCorrelationService(
      infraRepoPorts,
      codeHost,
      new PipelineConfig(),
      logger,
    ),
    createMockPipelineMetrics(),
  );

  return Object.assign(service, overrides);
}

export { createMockIncrementalReviewService };
