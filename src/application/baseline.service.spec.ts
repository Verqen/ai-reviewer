import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { BaselineService } from "~/application/baseline.service";
import type {
  BaselineState,
  ISnapshotRepository,
} from "~/domain/ports/snapshot.repository.port";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockSnapshotRepository } from "~/test-utils/mock-snapshot-repository";

function makeBaselineStateReader(): Mock<
  ISnapshotRepository["getBaselineState"]
> {
  return vi.fn<ISnapshotRepository["getBaselineState"]>();
}

describe("BaselineService.executeWaitUntilBaselineReadyForReview", () => {
  const bootstrapping: BaselineState = {
    commitSha: "s1",
    errorMessage: null,
    status: "bootstrapping",
  };
  const ready: BaselineState = {
    commitSha: "s1",
    errorMessage: null,
    status: "ready",
  };
  const failed: BaselineState = {
    commitSha: "s1",
    errorMessage: "x",
    status: "failed",
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when baseline is ready", async () => {
    const getBaselineState = makeBaselineStateReader().mockResolvedValue(ready);
    const warn = vi.fn();
    const service = new BaselineService(
      createMockSnapshotRepository({ getBaselineState }),
      createMockCodeHost(),
      createMockLogger({ warn }),
      { pollMs: 50, timeoutMs: 500 },
    );
    await service.executeWaitUntilBaselineReadyForReview(3);
    expect(getBaselineState).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns immediately when baseline is failed", async () => {
    const getBaselineState =
      makeBaselineStateReader().mockResolvedValue(failed);
    const warn = vi.fn();
    const service = new BaselineService(
      createMockSnapshotRepository({ getBaselineState }),
      createMockCodeHost(),
      createMockLogger({ warn }),
      { pollMs: 50, timeoutMs: 500 },
    );
    await service.executeWaitUntilBaselineReadyForReview(3);
    expect(getBaselineState).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("polls until baseline becomes ready", async () => {
    const getBaselineState = makeBaselineStateReader()
      .mockResolvedValueOnce(bootstrapping)
      .mockResolvedValueOnce(bootstrapping)
      .mockResolvedValue(ready);
    const warn = vi.fn();
    const service = new BaselineService(
      createMockSnapshotRepository({ getBaselineState }),
      createMockCodeHost(),
      createMockLogger({ warn }),
      { pollMs: 100, timeoutMs: 5000 },
    );
    const promise = service.executeWaitUntilBaselineReadyForReview(2);
    await vi.advanceTimersByTimeAsync(250);
    await promise;
    expect(getBaselineState).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs warning and returns when deadline elapses without ready baseline", async () => {
    const getBaselineState =
      makeBaselineStateReader().mockResolvedValue(bootstrapping);
    const warn = vi.fn();
    const service = new BaselineService(
      createMockSnapshotRepository({ getBaselineState }),
      createMockCodeHost(),
      createMockLogger({ warn }),
      { pollMs: 100, timeoutMs: 250 },
    );
    const promise = service.executeWaitUntilBaselineReadyForReview(9);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(warn).toHaveBeenCalledWith(
      { projectId: 9, timeoutMs: 250 },
      "Baseline not ready before review wait deadline; proceeding without codebase exploration",
    );
  });
});
