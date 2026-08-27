import { CommentResolutionService } from "~/application/comment-resolution.service";

import { createMockCodeHost } from "./mock-code-host";
import { createMockLogger } from "./mock-logger";
import { createMockReviewFindingRepository } from "./mock-review-finding-repository";

function createMockCommentResolutionService(
  overrides: Partial<CommentResolutionService> = {},
): CommentResolutionService {
  const service = new CommentResolutionService(
    createMockReviewFindingRepository(),
    createMockCodeHost(),
    createMockLogger(),
  );

  return Object.assign(service, overrides);
}

export { createMockCommentResolutionService };
