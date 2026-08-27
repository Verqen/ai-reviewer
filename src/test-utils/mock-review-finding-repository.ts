import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";

function createMockReviewFindingRepository(
  overrides: Partial<IReviewFindingRepository> = {},
): IReviewFindingRepository {
  return {
    createMany: () => Promise.resolve([]),
    existsByHostDiscussionId: () => Promise.resolve(false),
    findByProjectAndMr: () => Promise.resolve([]),
    findByRunId: () => Promise.resolve([]),
    updateResolution: () => Promise.resolve(),
    updateResolutionMany: () => Promise.resolve(),
    ...overrides,
  };
}

export { createMockReviewFindingRepository };
