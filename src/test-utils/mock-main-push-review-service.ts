import { MainPushReviewService } from "~/application/main-push-review.service";
import type { ReviewJob } from "~/domain/types/job.types";

import { createMockCodeHost } from "./mock-code-host";
import { createMockInfraRepoPorts } from "./mock-infra-repo-ports";
import { createMockJobQueue } from "./mock-job-queue";
import { createMockLogger } from "./mock-logger";

function createMockMainPushReviewService(
  overrides: Partial<MainPushReviewService> = {},
): MainPushReviewService {
  const service = new MainPushReviewService(
    createMockInfraRepoPorts(),
    createMockCodeHost(),
    createMockJobQueue<ReviewJob>(),
    createMockLogger(),
  );

  return Object.assign(service, overrides);
}

export { createMockMainPushReviewService };
