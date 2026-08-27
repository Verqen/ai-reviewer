import type { IReviewService } from "~/review/review.types";

function createMockReviewService(
  overrides: Partial<IReviewService> = {},
): IReviewService {
  return {
    respondToComment: () => Promise.resolve(),
    respondToFindingThreadClarification: () => Promise.resolve(""),
    reviewMergeRequest: () => Promise.resolve(),
    ...overrides,
  };
}

export { createMockReviewService };
