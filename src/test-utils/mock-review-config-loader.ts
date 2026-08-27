import { ReviewConfigLoader } from "~/application/review-config.loader";

import { createMockCodeHost } from "./mock-code-host";
import { createMockLogger } from "./mock-logger";
import { createMockReviewConfig } from "./mock-review-config";

function createMockReviewConfigLoader(
  overrides: Partial<ReviewConfigLoader> = {},
): ReviewConfigLoader {
  const loader = new ReviewConfigLoader(
    createMockCodeHost(),
    createMockLogger(),
  );
  const defaults: Partial<ReviewConfigLoader> = {
    load: () => Promise.resolve(createMockReviewConfig()),
  };

  return Object.assign(loader, defaults, overrides);
}

export { createMockReviewConfigLoader };
