import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import { PipelineConfig } from "~/config/pipeline.config";
import { ReviewRunConflictError } from "~/domain/errors/review-run.errors";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";
import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { ReviewRunRepository } from "./review-run.repository";

const RUN_STUCK_AFTER_MS = 30 * 60 * 1000;

function buildLifecycleService(
  runRepo: ReviewRunRepository,
): ReviewRunLifecycleService {
  process.env["RUN_STUCK_AFTER_MS"] = String(RUN_STUCK_AFTER_MS);
  const ports = createMockInfraRepoPorts();
  ports.reviewRunRepo = runRepo;
  return new ReviewRunLifecycleService(
    ports,
    createMockLogger(),
    new PipelineConfig(),
  );
}

let testDb: TestDatabase;
let repo: ReviewRunRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new ReviewRunRepository(testDb.db);
}, 300_000);

beforeEach(async () => {
  await testDb.wipe();
});

afterAll(async () => {
  await testDb.cleanup();
});

const START_PARAMS = {
  isIncremental: false,
  mrIid: 7,
  previousRunId: undefined,
  projectId: 42,
  triggerType: "mr_open" as const,
  versions: {
    baseSha: "base-abc",
    headSha: "head-abc",
    startSha: "base-abc",
  },
};

const BASE_INPUT = {
  baseCommitSha: "base-abc",
  headCommitSha: "head-abc",
  isIncremental: false,
  mrIid: 7,
  projectId: 42,
  startedAt: new Date("2024-06-15T12:00:00.000Z"),
  triggerType: "mr_open" as const,
};

describe("ReviewRunRepository", () => {
  it("creates a run already in progress", async () => {
    const run = await repo.create(BASE_INPUT);
    expect(run.id).toBeDefined();
    expect(run.status).toBe("in_progress");
    expect(run.startedAt).toEqual(BASE_INPUT.startedAt);
    expect(run.projectId).toBe(42);
    expect(run.mrIid).toBe(7);
  });

  it("findById returns the created run", async () => {
    const created = await repo.create(BASE_INPUT);
    const found = await repo.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it("findById returns undefined for unknown id", async () => {
    const found = await repo.findById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeUndefined();
  });

  it("findByProjectAndMr returns all runs ordered by queued_at desc", async () => {
    await repo.create({ ...BASE_INPUT, triggerType: "mr_open" });
    await repo.create({ ...BASE_INPUT, triggerType: "push" });
    const runs = await repo.findByProjectAndMr(42, 7);
    expect(runs.length).toBe(2);
  });

  it("findLatestByProjectAndMr returns most recent run", async () => {
    const first = await repo.create({ ...BASE_INPUT, triggerType: "mr_open" });
    await repo.updateStatus(first.id, "completed", new Date());

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await repo.create({ ...BASE_INPUT, triggerType: "push" });
    await repo.updateStatus(second.id, "completed", new Date());
    const latest = await repo.findLatestByProjectAndMr(42, 7);
    expect(latest).toBeDefined();
    expect([first.id, second.id]).toContain(latest?.id);
  });

  it("findLatestByProjectAndMr filters by triggerType when provided", async () => {
    const mainPushRun = await repo.create({
      ...BASE_INPUT,
      triggerType: "main_push",
    });
    await repo.updateStatus(
      mainPushRun.id,
      "completed",
      new Date(Date.now() - 10 * 60 * 1000),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const mrOpenRun = await repo.create({
      ...BASE_INPUT,
      triggerType: "mr_open",
    });
    await repo.updateStatus(mrOpenRun.id, "completed", new Date());

    const latestMainPush = await repo.findLatestByProjectAndMr(
      42,
      7,
      "main_push",
    );
    expect(latestMainPush?.id).toBe(mainPushRun.id);

    const latestAny = await repo.findLatestByProjectAndMr(42, 7);
    expect(latestAny?.id).toBe(mrOpenRun.id);
  });

  it("findLatestByProjectAndMr omits failed runs by default", async () => {
    const failed = await repo.create({ ...BASE_INPUT, triggerType: "push" });
    await repo.updateStatus(failed.id, "failed", new Date());
    const latest = await repo.findLatestByProjectAndMr(42, 7);
    expect(latest).toBeUndefined();
  });

  it("findLatestByProjectAndMr includes failed when includeFailedForBaseline", async () => {
    const failed = await repo.create({ ...BASE_INPUT, triggerType: "push" });
    await repo.updateStatus(failed.id, "failed", new Date());
    const latest = await repo.findLatestByProjectAndMr(42, 7, undefined, {
      includeFailedForBaseline: true,
    });
    expect(latest?.id).toBe(failed.id);
    expect(latest?.status).toBe("failed");
  });

  it("findLatestByProjectAndMr prefers newer completed over older failed when baseline flag set", async () => {
    const failed = await repo.create({
      ...BASE_INPUT,
      headCommitSha: "head-old",
      triggerType: "push",
    });
    await repo.updateStatus(failed.id, "failed", new Date(Date.now() - 60_000));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ok = await repo.create({
      ...BASE_INPUT,
      headCommitSha: "head-new",
      triggerType: "push",
    });
    await repo.updateStatus(ok.id, "completed", new Date());
    const latest = await repo.findLatestByProjectAndMr(42, 7, undefined, {
      includeFailedForBaseline: true,
    });
    expect(latest?.id).toBe(ok.id);
  });

  it("findByIdentity returns matching run", async () => {
    const created = await repo.create(BASE_INPUT);
    const found = await repo.findByIdentity(
      42,
      7,
      "head-abc",
      "base-abc",
      "mr_open",
    );
    expect(found?.id).toBe(created.id);
  });

  it("findByIdentity returns undefined for no match", async () => {
    await repo.create(BASE_INPUT);
    const found = await repo.findByIdentity(
      42,
      7,
      "head-abc",
      "base-abc",
      "mention",
    );
    expect(found).toBeUndefined();
  });

  it("updateStatus to in_progress sets started_at", async () => {
    const run = await repo.create(BASE_INPUT);
    const now = new Date();
    await repo.updateStatus(run.id, "in_progress", now);
    const updated = await repo.findById(run.id);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.startedAt).toBeDefined();
  });

  it("updateStatus to completed sets completed_at", async () => {
    const run = await repo.create(BASE_INPUT);
    const now = new Date();
    await repo.updateStatus(run.id, "completed", now);
    const updated = await repo.findById(run.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeDefined();
  });

  it("updateStats persists stats fields", async () => {
    const run = await repo.create(BASE_INPUT);
    await repo.updateStats(run.id, {
      completionTokens: 200,
      criticalCount: 2,
      filesReviewed: 3,
      promptTokens: 100,
      reviewModel: "claude-sonnet",
      totalFindings: 5,
      warningCount: 3,
    });
    const updated = await repo.findById(run.id);
    expect(updated?.totalFindings).toBe(5);
    expect(updated?.criticalCount).toBe(2);
    expect(updated?.reviewModel).toBe("claude-sonnet");
  });

  it("unique constraint rejects duplicate 5-tuple", async () => {
    await repo.create(BASE_INPUT);
    await expect(repo.create(BASE_INPUT)).rejects.toThrow();
  });

  it("failRun records status and reason in one statement, keeping earlier stats", async () => {
    const run = await repo.create(BASE_INPUT);
    await repo.updateStats(run.id, { filesReviewed: 4, totalFindings: 9 });

    await repo.failRun(run.id, {
      errorMessage: "pass exploded",
      timestamp: new Date("2024-06-15T12:30:00.000Z"),
    });

    const failed = await repo.findById(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("pass exploded");
    expect(failed?.completedAt).toEqual(new Date("2024-06-15T12:30:00.000Z"));
    expect(failed?.totalFindings).toBe(9);
    expect(failed?.filesReviewed).toBe(4);
  });

  it("failStuckRun fails an in_progress run once and refuses a second time", async () => {
    const run = await repo.create(BASE_INPUT);

    const first = await repo.failStuckRun(run.id, {
      errorMessage: "stuck",
      timestamp: new Date(),
    });
    const second = await repo.failStuckRun(run.id, {
      errorMessage: "stuck again",
      timestamp: new Date(),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const failed = await repo.findById(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toBe("stuck");
  });

  it("failStuckRun leaves the identity taken, so a fresh insert still conflicts", async () => {
    const run = await repo.create(BASE_INPUT);
    await repo.failStuckRun(run.id, {
      errorMessage: "stuck",
      timestamp: new Date(),
    });

    await expect(repo.create(BASE_INPUT)).rejects.toBeInstanceOf(
      ReviewRunConflictError,
    );
  });

  it("reclaimStuckRun restarts a stuck run in place and clears the previous attempt", async () => {
    const startedAt = new Date(Date.now() - RUN_STUCK_AFTER_MS - 60_000);
    const run = await repo.create({ ...BASE_INPUT, startedAt });
    await repo.updateStats(run.id, {
      errorMessage: "stale error",
      totalFindings: 3,
    });
    const restartedAt = new Date();

    const reclaimed = await repo.reclaimStuckRun({
      id: run.id,
      isIncremental: true,
      previousRunId: undefined,
      startedAt: restartedAt,
      stuckBefore: new Date(Date.now() - RUN_STUCK_AFTER_MS),
    });

    expect(reclaimed?.id).toBe(run.id);
    expect(reclaimed?.status).toBe("in_progress");
    expect(reclaimed?.startedAt).toEqual(restartedAt);
    expect(reclaimed?.isIncremental).toBe(true);
    expect(reclaimed?.errorMessage).toBeUndefined();
    expect(reclaimed?.totalFindings).toBeUndefined();
    expect(reclaimed?.completedAt).toBeUndefined();
    const runs = await repo.findByProjectAndMr(42, 7);
    expect(runs).toHaveLength(1);
  });

  it("restartFailedRun restarts a failed run in place and clears the previous attempt", async () => {
    const run = await repo.create({ ...BASE_INPUT, startedAt: new Date() });
    await repo.failRun(run.id, {
      errorMessage: "pass exploded",
      timestamp: new Date(),
    });
    const restartedAt = new Date();

    const restarted = await repo.restartFailedRun({
      id: run.id,
      isIncremental: true,
      previousRunId: undefined,
      startedAt: restartedAt,
    });

    expect(restarted?.id).toBe(run.id);
    expect(restarted?.status).toBe("in_progress");
    expect(restarted?.startedAt).toEqual(restartedAt);
    expect(restarted?.errorMessage).toBeUndefined();
    expect(restarted?.completedAt).toBeUndefined();
    const runs = await repo.findByProjectAndMr(42, 7);
    expect(runs).toHaveLength(1);
  });

  it("restartFailedRun refuses a run that is not failed", async () => {
    const run = await repo.create({ ...BASE_INPUT, startedAt: new Date() });

    const restarted = await repo.restartFailedRun({
      id: run.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
    });

    expect(restarted).toBeUndefined();
  });

  it("restartFailedRun lets only one worker win the same failed run", async () => {
    const run = await repo.create({ ...BASE_INPUT, startedAt: new Date() });
    await repo.failRun(run.id, {
      errorMessage: "pass exploded",
      timestamp: new Date(),
    });

    const [first, second] = await Promise.all([
      repo.restartFailedRun({
        id: run.id,
        isIncremental: false,
        previousRunId: undefined,
        startedAt: new Date(),
      }),
      repo.restartFailedRun({
        id: run.id,
        isIncremental: false,
        previousRunId: undefined,
        startedAt: new Date(),
      }),
    ]);

    expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
  });

  it("a failed run is retried in place by the lifecycle service", async () => {
    const service = buildLifecycleService(repo);
    const started = await service.startRun(START_PARAMS);
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") return;
    await repo.failRun(started.reviewRun.id, {
      errorMessage: "pass exploded",
      timestamp: new Date(),
    });

    const retried = await service.startRun(START_PARAMS);

    expect(retried.outcome).toBe("started");
    expect(
      retried.outcome === "started" ? retried.reviewRun.id : undefined,
    ).toBe(started.reviewRun.id);
    const runs = await repo.findByProjectAndMr(42, 7);
    expect(runs).toHaveLength(1);
  });

  it("reclaimStuckRun leaves a run that is still within the stuck window", async () => {
    const run = await repo.create({ ...BASE_INPUT, startedAt: new Date() });

    const reclaimed = await repo.reclaimStuckRun({
      id: run.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
      stuckBefore: new Date(Date.now() - RUN_STUCK_AFTER_MS),
    });

    expect(reclaimed).toBeUndefined();
  });

  it("reclaimStuckRun lets only one worker win the same stuck run", async () => {
    const startedAt = new Date(Date.now() - RUN_STUCK_AFTER_MS - 60_000);
    const run = await repo.create({ ...BASE_INPUT, startedAt });
    const stuckBefore = new Date(Date.now() - RUN_STUCK_AFTER_MS);

    const first = await repo.reclaimStuckRun({
      id: run.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
      stuckBefore,
    });
    const second = await repo.reclaimStuckRun({
      id: run.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
      stuckBefore,
    });

    expect(first?.id).toBe(run.id);
    expect(second).toBeUndefined();
  });

  it("reclaimStuckRun refuses a run that already reached a terminal state", async () => {
    const startedAt = new Date(Date.now() - RUN_STUCK_AFTER_MS - 60_000);
    const run = await repo.create({ ...BASE_INPUT, startedAt });
    await repo.failRun(run.id, {
      errorMessage: "already failed",
      timestamp: new Date(),
    });

    const reclaimed = await repo.reclaimStuckRun({
      id: run.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
      stuckBefore: new Date(Date.now() - RUN_STUCK_AFTER_MS),
    });

    expect(reclaimed).toBeUndefined();
  });

  it("reclaimStuckRun falls back to queued_at when started_at was never set", async () => {
    const queuedAt = new Date(Date.now() - RUN_STUCK_AFTER_MS - 60_000);
    const inserted = await testDb.db
      .insertInto("review_run")
      .values({
        base_commit_sha: BASE_INPUT.baseCommitSha,
        head_commit_sha: BASE_INPUT.headCommitSha,
        is_incremental: false,
        mr_iid: BASE_INPUT.mrIid,
        project_id: BASE_INPUT.projectId,
        queued_at: queuedAt,
        started_at: null,
        status: "in_progress",
        trigger_type: BASE_INPUT.triggerType,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const reclaimed = await repo.reclaimStuckRun({
      id: inserted.id,
      isIncremental: false,
      previousRunId: undefined,
      startedAt: new Date(),
      stuckBefore: new Date(Date.now() - RUN_STUCK_AFTER_MS),
    });

    expect(reclaimed?.id).toBe(inserted.id);
  });

  it("reclaims a stuck run and starts the next attempt on the same row", async () => {
    const startedAt = new Date(Date.now() - RUN_STUCK_AFTER_MS - 60_000);
    const stuck = await repo.create({ ...BASE_INPUT, startedAt });
    const service = buildLifecycleService(repo);

    const result = await service.startRun({
      isIncremental: false,
      mrIid: BASE_INPUT.mrIid,
      previousRunId: undefined,
      projectId: BASE_INPUT.projectId,
      triggerType: BASE_INPUT.triggerType,
      versions: {
        baseSha: BASE_INPUT.baseCommitSha,
        headSha: BASE_INPUT.headCommitSha,
        startSha: BASE_INPUT.baseCommitSha,
      },
    });

    expect(result.outcome).toBe("started");
    expect(result.outcome === "started" ? result.reviewRun.id : undefined).toBe(
      stuck.id,
    );
    const runs = await repo.findByProjectAndMr(
      BASE_INPUT.projectId,
      BASE_INPUT.mrIid,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("in_progress");
    expect(runs[0]?.startedAt?.getTime()).toBeGreaterThan(startedAt.getTime());
  });

  it("skips a fresh in_progress run instead of reclaiming it", async () => {
    await repo.create({ ...BASE_INPUT, startedAt: new Date() });
    const service = buildLifecycleService(repo);

    const result = await service.startRun({
      isIncremental: false,
      mrIid: BASE_INPUT.mrIid,
      previousRunId: undefined,
      projectId: BASE_INPUT.projectId,
      triggerType: BASE_INPUT.triggerType,
      versions: {
        baseSha: BASE_INPUT.baseCommitSha,
        headSha: BASE_INPUT.headCommitSha,
        startSha: BASE_INPUT.baseCommitSha,
      },
    });

    expect(result).toEqual({
      outcome: "skipped",
      reason: "already_in_progress",
    });
  });

  it("deleteCompletedOrFailedBefore removes runs, findings, and returns count", async () => {
    const run = await repo.create(BASE_INPUT);
    const completedAt = new Date(Date.now() - 60_000);
    await repo.updateStatus(run.id, "completed", completedAt);
    await testDb.db
      .insertInto("review_finding")
      .values({
        category: "bug",
        comment: "Finding text",
        confidence: 0.9,
        dismiss_reason: null,
        end_line_number: null,
        file_path: "src/index.ts",
        host_discussion_id: null,
        host_note_id: null,
        hunk_header: null,
        line_excerpt: null,
        line_number: 10,
        line_type: "added",
        model: "test-model",
        old_path: null,
        original_snippet: null,
        pass_name: "file-review",
        resolution: "pending",
        resolved_at: null,
        resolved_by: null,
        review_run_id: run.id,
        severity: "warning",
        suggestion: null,
      })
      .execute();
    const deletedCount = await repo.deleteCompletedOrFailedBefore(new Date());
    expect(deletedCount).toBe(1);
    expect(await repo.findById(run.id)).toBeUndefined();
    const findings = await testDb.db
      .selectFrom("review_finding")
      .selectAll()
      .where("review_run_id", "=", run.id)
      .execute();
    expect(findings).toHaveLength(0);
  });

  it("deleteCompletedOrFailedBefore does not remove queued runs", async () => {
    const run = await repo.create(BASE_INPUT);
    await repo.deleteCompletedOrFailedBefore(new Date());
    expect(await repo.findById(run.id)).toBeDefined();
  });

  it("deleteCompletedOrFailedBefore removes failed runs before cutoff", async () => {
    const run = await repo.create(BASE_INPUT);
    const completedAt = new Date(Date.now() - 60_000);
    await repo.updateStatus(run.id, "failed", completedAt);
    const deletedCount = await repo.deleteCompletedOrFailedBefore(new Date());
    expect(deletedCount).toBe(1);
    expect(await repo.findById(run.id)).toBeUndefined();
  });
});
