import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";

import { createMockReviewRun } from "./mock-infra-repo-ports";

function createMockReviewRunRepository(
  overrides: Partial<IReviewRunRepository> = {},
): IReviewRunRepository {
  return {
    completeRun: () => Promise.resolve(),
    create: () => Promise.resolve(createMockReviewRun()),
    deleteCompletedOrFailedBefore: () => Promise.resolve(0),
    failRun: () => Promise.resolve(),
    failStuckRun: () => Promise.resolve(true),
    findById: () => Promise.resolve(undefined),
    findByIdentity: () => Promise.resolve(undefined),
    findByProjectAndMr: () => Promise.resolve([]),
    findLatestByProjectAndMr: () => Promise.resolve(undefined),
    reclaimStuckRun: () => Promise.resolve(undefined),
    restartFailedRun: () => Promise.resolve(undefined),
    updateStats: () => Promise.resolve(),
    updateStatus: () => Promise.resolve(),
    ...overrides,
  };
}

export { createMockReviewRunRepository };
