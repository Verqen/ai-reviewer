import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { PipelineConfig } from "~/config/pipeline.config";
import { ReviewRunConflictError } from "~/domain/errors/review-run.errors";
import type {
  CreateReviewRunInput,
  FailReviewRunInput,
  IReviewRunRepository,
  ReclaimStuckReviewRunInput,
  RestartFailedReviewRunInput,
} from "~/domain/ports/review-run.repository.port";
import type { ReviewRun, TriggerType } from "~/domain/types/review.types";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";

const RUN_STUCK_AFTER_MS = 30 * 60 * 1000;

const VERSIONS = {
  baseSha: "base-sha",
  headSha: "head-sha",
  startSha: "start-sha",
};

interface RepoCalls {
  createInputs: CreateReviewRunInput[];
  restartInputs: RestartFailedReviewRunInput[];
  failedRuns: Array<{ id: string; params: FailReviewRunInput }>;
  reclaimInputs: ReclaimStuckReviewRunInput[];
}

function identityKey(run: {
  baseCommitSha: string;
  headCommitSha: string;
  mrIid: number;
  projectId: number;
  triggerType: TriggerType;
}): string {
  return [
    run.projectId,
    run.mrIid,
    run.headCommitSha,
    run.baseCommitSha,
    run.triggerType,
  ].join("|");
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

function createFakeReviewRunRepository(options: {
  existingRun?: ReviewRun;
  identityTakenByConcurrentWriter?: boolean;
  reclaimBlockedByOtherWorker?: boolean;
  restartBlockedByOtherWorker?: boolean;
}): { calls: RepoCalls; repo: IReviewRunRepository } {
  const calls: RepoCalls = {
    createInputs: [],
    failedRuns: [],
    reclaimInputs: [],
    restartInputs: [],
  };
  const runsById = new Map<string, ReviewRun>();
  if (options.existingRun) {
    runsById.set(options.existingRun.id, options.existingRun);
  }
  let nextRunNumber = 1;

  function findByIdentityKey(key: string): ReviewRun | undefined {
    for (const run of runsById.values()) {
      if (identityKey(run) === key) {
        return run;
      }
    }
    return undefined;
  }

  const repo: IReviewRunRepository = {
    completeRun: () => Promise.resolve(),

    create: (input: CreateReviewRunInput) => {
      calls.createInputs.push(input);
      if (findByIdentityKey(identityKey(input)) !== undefined) {
        return Promise.reject(new ReviewRunConflictError());
      }
      const created: ReviewRun = {
        baseCommitSha: input.baseCommitSha,
        headCommitSha: input.headCommitSha,
        id: `created-run-${String(nextRunNumber)}`,
        isIncremental: input.isIncremental,
        mrIid: input.mrIid,
        previousRunId: input.previousRunId,
        projectId: input.projectId,
        queuedAt: input.startedAt,
        startedAt: input.startedAt,
        status: "in_progress",
        triggerType: input.triggerType,
      };
      nextRunNumber += 1;
      runsById.set(created.id, created);
      return Promise.resolve(created);
    },

    deleteCompletedOrFailedBefore: () => Promise.resolve(0),

    failRun: (id: string, params: FailReviewRunInput) => {
      calls.failedRuns.push({ id, params });
      const run = runsById.get(id);
      if (run) {
        runsById.set(id, {
          ...run,
          completedAt: params.timestamp,
          errorMessage: params.errorMessage,
          status: "failed",
        });
      }
      return Promise.resolve();
    },

    failStuckRun: (id: string) => {
      const run = runsById.get(id);
      if (!run || run.status !== "in_progress") {
        return Promise.resolve(false);
      }
      runsById.set(id, { ...run, status: "failed" });
      return Promise.resolve(true);
    },

    findById: (id: string) => Promise.resolve(runsById.get(id)),

    findByIdentity: (
      projectId: number,
      mrIid: number,
      headCommitSha: string,
      baseCommitSha: string,
      triggerType: TriggerType,
    ) =>
      Promise.resolve(
        options.identityTakenByConcurrentWriter === true
          ? undefined
          : findByIdentityKey(
              identityKey({
                baseCommitSha,
                headCommitSha,
                mrIid,
                projectId,
                triggerType,
              }),
            ),
      ),

    findByProjectAndMr: () => Promise.resolve([...runsById.values()]),

    findLatestByProjectAndMr: () => Promise.resolve(undefined),

    reclaimStuckRun: (input: ReclaimStuckReviewRunInput) => {
      calls.reclaimInputs.push(input);
      const run = runsById.get(input.id);
      if (!run || run.status !== "in_progress") {
        return Promise.resolve(undefined);
      }
      const aliveSince = run.startedAt ?? run.queuedAt;
      if (
        options.reclaimBlockedByOtherWorker === true ||
        aliveSince.getTime() > input.stuckBefore.getTime()
      ) {
        return Promise.resolve(undefined);
      }
      const reclaimed: ReviewRun = {
        ...run,
        isIncremental: input.isIncremental,
        previousRunId: input.previousRunId,
        startedAt: input.startedAt,
        status: "in_progress",
      };
      runsById.set(reclaimed.id, reclaimed);
      return Promise.resolve(reclaimed);
    },

    restartFailedRun: (input: RestartFailedReviewRunInput) => {
      calls.restartInputs.push(input);
      const run = runsById.get(input.id);
      if (
        !run ||
        run.status !== "failed" ||
        options.restartBlockedByOtherWorker === true
      ) {
        return Promise.resolve(undefined);
      }
      const restarted: ReviewRun = {
        ...run,
        completedAt: undefined,
        errorMessage: undefined,
        isIncremental: input.isIncremental,
        previousRunId: input.previousRunId,
        startedAt: input.startedAt,
        status: "in_progress",
      };
      runsById.set(restarted.id, restarted);
      return Promise.resolve(restarted);
    },

    updateStats: () => Promise.resolve(),

    updateStatus: () => Promise.resolve(),
  };

  return { calls, repo };
}

function createPipelineConfig(): PipelineConfig {
  process.env["RUN_STUCK_AFTER_MS"] = String(RUN_STUCK_AFTER_MS);
  return new PipelineConfig();
}

function makeMocks(options: {
  existingRun?: ReviewRun;
  identityTakenByConcurrentWriter?: boolean;
  reclaimBlockedByOtherWorker?: boolean;
  restartBlockedByOtherWorker?: boolean;
}): {
  calls: RepoCalls;
  pipelineConfig: PipelineConfig;
  ports: ReviewInfraRepoPorts;
} {
  const { calls, repo } = createFakeReviewRunRepository(options);
  const ports = createMockInfraRepoPorts();
  ports.reviewRunRepo = repo;
  return { calls, pipelineConfig: createPipelineConfig(), ports };
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
      pipelineConfig,
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
      pipelineConfig,
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
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "already_in_progress",
    });
    expect(calls.createInputs).toHaveLength(0);
    expect(calls.reclaimInputs).toHaveLength(0);
  });

  it("reclaims a stuck in_progress run in place instead of inserting a colliding identity", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(startedAt.getTime() + RUN_STUCK_AFTER_MS + 1000);
    vi.setSystemTime(now);

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
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    expect(result.reviewRun.id).toBe("stuck-run-id");
    expect(result.reviewRun.startedAt).toEqual(now);
    expect(result.reviewRun.status).toBe("in_progress");
    expect(calls.reclaimInputs).toEqual([
      {
        id: "stuck-run-id",
        isIncremental: false,
        previousRunId: undefined,
        startedAt: now,
        stuckBefore: new Date(now.getTime() - RUN_STUCK_AFTER_MS),
      },
    ]);
    expect(calls.createInputs).toHaveLength(0);
  });

  it("carries the new attempt shape onto the reclaimed run", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(new Date(startedAt.getTime() + RUN_STUCK_AFTER_MS + 1000));

    const { pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({
        id: "stuck-run-id",
        isIncremental: false,
        startedAt,
        status: "in_progress",
      }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun({
      ...makeStartParams(),
      isIncremental: true,
      previousRunId: "previous-run-id",
    });

    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") return;
    expect(result.reviewRun.isIncremental).toBe(true);
    expect(result.reviewRun.previousRunId).toBe("previous-run-id");
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
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    expect(calls.reclaimInputs).toHaveLength(1);
  });

  it("skips identity pre-check entirely for mention triggers", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ status: "completed" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams("mention"));

    expect(result.outcome).toBe("started");
    expect(calls.createInputs).toHaveLength(1);
  });

  it("skips when another worker still holds the stuck run", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(new Date(startedAt.getTime() + RUN_STUCK_AFTER_MS + 1000));

    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({
        id: "stuck-run-id",
        startedAt,
        status: "in_progress",
      }),
      reclaimBlockedByOtherWorker: true,
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "already_in_progress",
    });
    expect(calls.createInputs).toHaveLength(0);
  });

  it("restarts a failed attempt in place instead of reporting a duplicate", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ id: "failed-run-id", status: "failed" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result.outcome).toBe("started");
    expect(result.outcome === "started" ? result.reviewRun.id : undefined).toBe(
      "failed-run-id",
    );
    expect(
      result.outcome === "started" ? result.reviewRun.status : undefined,
    ).toBe("in_progress");
    expect(calls.restartInputs).toHaveLength(1);
    expect(calls.createInputs).toHaveLength(0);
  });

  it("skips when another worker restarts the failed run first", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ id: "failed-run-id", status: "failed" }),
      restartBlockedByOtherWorker: true,
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "already_in_progress",
    });
    expect(calls.createInputs).toHaveLength(0);
  });

  it("reports a unique violation when a concurrent writer takes the identity after the lookup", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ status: "failed" }),
      identityTakenByConcurrentWriter: true,
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    const result = await service.startRun(makeStartParams());

    expect(result).toEqual({
      outcome: "skipped",
      reason: "unique_violation",
    });
    expect(calls.createInputs).toHaveLength(1);
  });
});

describe("ReviewRunLifecycleService.markRunFailed", () => {
  it("records status and reason in a single write", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ id: "run-to-fail" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    await service.markRunFailed("run-to-fail", new Error("pass exploded"));

    expect(calls.failedRuns).toHaveLength(1);
    expect(calls.failedRuns[0]?.id).toBe("run-to-fail");
    expect(calls.failedRuns[0]?.params.errorMessage).toBe("pass exploded");
    const failed = await ports.reviewRunRepo.findById("run-to-fail");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("pass exploded");
  });

  it("stringifies non-Error rejections", async () => {
    const { calls, pipelineConfig, ports } = makeMocks({
      existingRun: buildRun({ id: "run-to-fail" }),
    });
    const service = new ReviewRunLifecycleService(
      ports,
      createMockLogger(),
      pipelineConfig,
    );

    await service.markRunFailed("run-to-fail", "plain failure");

    expect(calls.failedRuns[0]?.params.errorMessage).toBe("plain failure");
  });
});
