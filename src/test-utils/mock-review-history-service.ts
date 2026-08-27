import { ReviewHistoryService } from "~/application/review-history.service";

import { createMockReviewFindingRepository } from "./mock-review-finding-repository";

function createMockReviewHistoryService(
  overrides: Partial<ReviewHistoryService> = {},
): ReviewHistoryService {
  const service = new ReviewHistoryService(createMockReviewFindingRepository());

  return Object.assign(service, overrides);
}

export { createMockReviewHistoryService };
