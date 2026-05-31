import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaselineService } from "~/application/baseline.service";
import type {
  BaselineState,
  ISnapshotRepository,
} from "~/domain/ports/snapshot.repository.port";

function makeLogger(): Pick<FastifyBaseLogger, "warn"> &
  Partial<FastifyBaseLogger> {
  return {
    warn: vi.fn(),
  };
}

function bootstrapShape(): Pick<ISnapshotRepository, "getBaselineState"> & {
  getBaselineState: () => Promise<BaselineState | null>;
} {
  return {
    getBaselineState: vi.fn(),
  };
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
    const snapshotRepo = bootstrapShape();
    snapshotRepo.getBaselineState = vi.fn().mockResolvedValue(ready);
    const logger = makeLogger();
    const service = new BaselineService(
      snapshotRepo as unknown as ISnapshotRepository,
      {} as never,
      logger as unknown as FastifyBaseLogger,
      { pollMs: 50, timeoutMs: 500 },
    );
    await service.executeWaitUntilBaselineReadyForReview(3);
    expect(snapshotRepo.getBaselineState).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns immediately when baseline is failed", async () => {
    const snapshotRepo = bootstrapShape();
    snapshotRepo.getBaselineState = vi.fn().mockResolvedValue(failed);
    const logger = makeLogger();
    const service = new BaselineService(
      snapshotRepo as unknown as ISnapshotRepository,
      {} as never,
      logger as unknown as FastifyBaseLogger,
      { pollMs: 50, timeoutMs: 500 },
    );
    await service.executeWaitUntilBaselineReadyForReview(3);
    expect(snapshotRepo.getBaselineState).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("polls until baseline becomes ready", async () => {
    const snapshotRepo = bootstrapShape();
    snapshotRepo.getBaselineState = vi
      .fn()
      .mockResolvedValueOnce(bootstrapping)
      .mockResolvedValueOnce(bootstrapping)
      .mockResolvedValue(ready);
    const logger = makeLogger();
    const service = new BaselineService(
      snapshotRepo as unknown as ISnapshotRepository,
      {} as never,
      logger as unknown as FastifyBaseLogger,
      { pollMs: 100, timeoutMs: 5000 },
    );
    const promise = service.executeWaitUntilBaselineReadyForReview(2);
    await vi.advanceTimersByTimeAsync(250);
    await promise;
    expect(snapshotRepo.getBaselineState).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs warning and returns when deadline elapses without ready baseline", async () => {
    const snapshotRepo = bootstrapShape();
    snapshotRepo.getBaselineState = vi.fn().mockResolvedValue(bootstrapping);
    const logger = makeLogger();
    const service = new BaselineService(
      snapshotRepo as unknown as ISnapshotRepository,
      {} as never,
      logger as unknown as FastifyBaseLogger,
      { pollMs: 100, timeoutMs: 250 },
    );
    const promise = service.executeWaitUntilBaselineReadyForReview(9);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(logger.warn).toHaveBeenCalledWith(
      { projectId: 9, timeoutMs: 250 },
      "Baseline not ready before review wait deadline; proceeding without codebase exploration",
    );
  });
});
