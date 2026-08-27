import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";
import {
  ResolvedReviewPipelineConfigSchema,
  type ReviewPipelineConfig,
} from "~/domain/types/config.types";

function createMockReviewConfig(
  overrides: Partial<ReviewPipelineConfig> = {},
): ReviewPipelineConfig {
  return ResolvedReviewPipelineConfigSchema.parse({
    models: {
      premium: null,
      review: OPENROUTER_REVIEW_MODEL,
      triage: OPENROUTER_TRIAGE_MODEL,
    },
    severityThreshold: "info",
    ...overrides,
  });
}

export { createMockReviewConfig };
