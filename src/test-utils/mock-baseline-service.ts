import { BaselineService } from "~/application/baseline.service";

import { createMockCodeHost } from "./mock-code-host";
import { createMockLogger } from "./mock-logger";
import { createMockSnapshotRepository } from "./mock-snapshot-repository";

function createMockBaselineService(
  overrides: Partial<BaselineService> = {},
): BaselineService {
  const service = new BaselineService(
    createMockSnapshotRepository(),
    createMockCodeHost(),
    createMockLogger(),
  );

  return Object.assign(service, overrides);
}

export { createMockBaselineService };
