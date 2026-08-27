import { ReviewLearningService } from "~/application/review-learning.service";
import { OPENROUTER_REVIEW_MODEL } from "~/config/models";

import { createMockDismissedPatternRepository } from "./mock-dismissed-pattern-repository";
import { createMockLlmClient } from "./mock-llm-client";
import { createMockLogger } from "./mock-logger";
import { createMockReviewFindingRepository } from "./mock-review-finding-repository";

function createMockReviewLearningService(
  overrides: Partial<ReviewLearningService> = {},
): ReviewLearningService {
  const service = new ReviewLearningService(
    createMockDismissedPatternRepository(),
    createMockReviewFindingRepository(),
    createMockLlmClient(),
    createMockLogger(),
    OPENROUTER_REVIEW_MODEL,
  );

  return Object.assign(service, overrides);
}

export { createMockReviewLearningService };
