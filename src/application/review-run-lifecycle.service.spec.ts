import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { PipelineConfig } from "~/config/pipeline.config";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type {
  ReviewRun,
  ReviewStatus,
  TriggerType,
} from "~/domain/types/review.types";
import { createMockLogger } from "~/test-utils/mock-logger";

const RUN_STUCK_AFTER_MS = 30 * 60 * 1000;

const VERSIONS = {
  baseSha: "base-sha",
  headSha: "head-sha",
  startSha: "start-sha",
};

interface RepoCalls {
  createInputs: unknown[];
  failedRunIds: string[];
  failedStats: Array<{ errorMessage: string | undefined; id: string }>;
}

function buildRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    baseCommitSha: "base-sha",
    headCommitSha: "head-sha",
    id: "existing-run-id",
    isIncremental: false,
    mrIid: 1,
    projectId: 1,
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    status: "in_progress",
    triggerType: "push",
    ...overrides,
  };
}

function makeMocks(options: {
  createdRun?: ReviewRun;
  existingRun?: ReviewRun;
}): {
  calls: RepoCalls;
  pipelineConfig: PipelineConfig;
  ports: ReviewInfraRepoPorts;
} {
  const calls: RepoCalls = {
    createInputs: [],
    failedRunIds: [],
    failedStats: [],
  };
  const createdRun: ReviewRun =
    options.createdRun ??
    buildRun({
      id: "new-run-id",
      queuedAt: new Date(),
      status: "queued",
    });
  const reviewRunRepo: IReviewRunRepository = {
    completeRun: () => Promise.resolve(),
    create: (input) => {
      calls.createInputs.push(input);
      return Promise.resolve(createdRun);
    },
    deleteCompletedOrFailedBefore: () => Promise.resolve(0),
    findById: () => Promise.resolve(undefined),
    findByIdentity: () => Promise.resolve(options.existingRun),
    findByProjectAndMr: () => Promise.resolve([]),
    findLatestByProjectAndMr: () => Promise.resolve(undefined),
    updateStats: (id, stats) => {
      calls.failedStats.push({ errorMessage: stats.errorMessage, id });
      return Promise.resolve();
    },
    updateStatus: (id, status: ReviewStatus) => {
      if (status === "failed") {
        calls.failedRunIds.push(id);
      }
      return Promise.resolve();
    },
  };
  const ports = { reviewRunRepo } as unknown as ReviewInfraRepoPorts;
  const pipelineConfig = {
    envs: { RUN_STUCK_AFTER_MS },
  } as unknown as PipelineConfig;
  return { calls, pipelineConfig, ports };
}

function makeStartParams(triggerType: TriggerType = "push") {
  return {
    isIncremental: false,
    mrIid: 1,
    previousRunId: undefined,
    projectId: 1,
    triggerType,
    versions: VERSIONS,
  };
}

describe("ReviewRunLifecycleService.startRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a new run when no prior run exists", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({});
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    expect(calls.createInputs).toHaveLength(1);
  });

  it("skips when prior run with same identity is completed", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ status: "completed" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "completed_duplicate",
    });
    expect(calls.createInputs).toHaveLength(0);
  });

  it("skips when prior in_progress run is younger than RUN_STUCK_AFTER_MS", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(new Date(startedAt.getTime() + RUN_STUCK_AFTER_MS - 1000));

    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ startedAt, status: "in_progress" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "already_in_progress",
    });
    expect(calls.createInputs).toHaveLength(0);
    expect(calls.failedRunIds).toHaveLength(0);
  });

  it("reclaims a stuck in_progress run older than RUN_STUCK_AFTER_MS and starts a new one", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(new Date(startedAt.getTime() + RUN_STUCK_AFTER_MS + 1000));

    const stuckRun = buildRun({
      id: "stuck-run-id",
      startedAt,
      status: "in_progress",
    });
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: stuckRun,
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    expect(calls.failedRunIds).toEqual(["stuck-run-id"]);
    expect(calls.failedStats[0]?.id).toBe("stuck-run-id");
    expect(calls.failedStats[0]?.errorMessage).toMatch(/reclaimed: stuck/);
    expect(calls.createInputs).toHaveLength(1);
  });

  it("uses queuedAt when startedAt is missing on the in_progress run", async () => {
    const queuedAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(new Date(queuedAt.getTime() + RUN_STUCK_AFTER_MS + 5000));

    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({
        queuedAt,
        startedAt: undefined,
        status: "in_progress",
      }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    expect(calls.failedRunIds).toHaveLength(1);
  });

  it("skips identity pre-check entirely for mention triggers", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ status: "completed" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams("mention"));

    expect(result.outcome).toBe("started");
    expect(calls.createInputs).toHaveLength(1);
  });

  it("returns skipped on Postgres unique violation (23505) during create", async () => {
    const { pipelineConfig, ports } = makeMocks({});
    const uniqueErr = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    ports.reviewRunRepo.create = () => Promise.reject(uniqueErr);

    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "unique_violation",
    });
  });
});
