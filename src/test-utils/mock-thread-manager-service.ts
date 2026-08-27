import { ThreadManagerService } from "~/application/thread-manager.service";

import { createMockCodeHost } from "./mock-code-host";
import { createMockLogger } from "./mock-logger";
import { createMockReviewFindingRepository } from "./mock-review-finding-repository";
import { createMockReviewLearningService } from "./mock-review-learning-service";
import { createMockReviewService } from "./mock-review-service";

function createMockThreadManagerService(
  overrides: Partial<ThreadManagerService> = {},
): ThreadManagerService {
  const service = new ThreadManagerService(
    createMockReviewFindingRepository(),
    createMockCodeHost(),
    createMockReviewLearningService(),
    createMockReviewService(),
    createMockLogger(),
  );

  return Object.assign(service, overrides);
}

export { createMockThreadManagerService };
