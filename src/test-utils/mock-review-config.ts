import {
  ResolvedReviewPipelineConfigSchema,
  type ReviewPipelineConfig,
} from "~/domain/types/config.types";

function createMockReviewConfig(
  overrides: Partial<ReviewPipelineConfig> = {},
): ReviewPipelineConfig {
  return ResolvedReviewPipelineConfigSchema.parse({
    severityThreshold: "info",
    ...overrides,
  });
}

export { createMockReviewConfig };
