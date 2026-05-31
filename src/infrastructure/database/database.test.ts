import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "~/infrastructure/database/types";
import { createTestDatabase } from "~/test-utils/test-database";

let db: Kysely<Database>;
let cleanup: () => Promise<void>;
let wipe: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  db = testDb.db;
  cleanup = testDb.cleanup;
  wipe = testDb.wipe;
});

afterAll(async () => {
  await cleanup?.();
});

beforeEach(async () => {
  await wipe();
});

describe("database migrations", () => {
  it("creates review_run table", async () => {
    const result = await db.selectFrom("review_run").selectAll().execute();
    expect(result).toHaveLength(0);
  });

  it("creates review_finding table", async () => {
    const result = await db.selectFrom("review_finding").selectAll().execute();
    expect(result).toHaveLength(0);
  });

  it("creates snapshot_blob table", async () => {
    const result = await db.selectFrom("snapshot_blob").selectAll().execute();
    expect(result).toHaveLength(0);
  });

  it("creates baseline_state table", async () => {
    const result = await db.selectFrom("baseline_state").selectAll().execute();
    expect(result).toHaveLength(0);
  });

  it("creates dismissed_pattern table", async () => {
    const result = await db
      .selectFrom("dismissed_pattern")
      .selectAll()
      .execute();
    expect(result).toHaveLength(0);
  });
});

describe("review_run CRUD", () => {
  it("inserts and retrieves a review run", async () => {
    const inserted = await db
      .insertInto("review_run")
      .values({
        base_commit_sha: "def456",
        head_commit_sha: "abc123",
        is_incremental: false,
        mr_iid: 7,
        previous_run_id: null,
        project_id: 42,
        status: "queued",
        trigger_type: "mr_open",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBeDefined();
    expect(inserted.project_id).toBe(42);
    expect(inserted.mr_iid).toBe(7);
    expect(inserted.trigger_type).toBe("mr_open");
    expect(inserted.status).toBe("queued");
  });

  it("enforces unique constraint on (project_id, mr_iid, head_commit_sha, base_commit_sha, trigger_type)", async () => {
    const values = {
      base_commit_sha: "def456",
      head_commit_sha: "abc123",
      is_incremental: false,
      mr_iid: 7,
      previous_run_id: null,
      project_id: 42,
      status: "queued" as const,
      trigger_type: "mr_open" as const,
    };

    await db.insertInto("review_run").values(values).execute();

    await expect(
      db.insertInto("review_run").values(values).execute()
    ).rejects.toThrow();
  });
});

describe("review_finding CRUD", () => {
  it("inserts findings and cascades delete", async () => {
    const run = await db
      .insertInto("review_run")
      .values({
        base_commit_sha: "def456",
        head_commit_sha: "abc123",
        is_incremental: false,
        mr_iid: 7,
        previous_run_id: null,
        project_id: 42,
        status: "in_progress",
        trigger_type: "mr_open",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto("review_finding")
      .values({
        category: "bug",
        comment: "Missing null check",
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

    const findings = await db
      .selectFrom("review_finding")
      .selectAll()
      .where("review_run_id", "=", run.id)
      .execute();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.comment).toBe("Missing null check");

    await db.deleteFrom("review_run").where("id", "=", run.id).execute();

    const remaining = await db
      .selectFrom("review_finding")
      .selectAll()
      .where("review_run_id", "=", run.id)
      .execute();

    expect(remaining).toHaveLength(0);
  });
});
