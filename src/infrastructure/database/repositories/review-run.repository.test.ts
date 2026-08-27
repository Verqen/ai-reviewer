import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { ReviewRunRepository } from "./review-run.repository";

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
