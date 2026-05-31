import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { SnapshotRepository } from "./snapshot.repository";

let testDb: TestDatabase;
let repo: SnapshotRepository;

const OLD_CREATED_AT = new Date("2010-06-01T00:00:00.000Z");
const CUTOFF = new Date("2015-06-01T00:00:00.000Z");
const NEW_CREATED_AT = new Date("2020-06-01T00:00:00.000Z");

beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new SnapshotRepository(testDb.db);
}, 300_000);

beforeEach(async () => {
  await testDb.wipe();
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("SnapshotRepository", () => {
  it("deleteOldSnapshotsBefore removes old commits, cascaded entries, and orphan blobs; retains shared blobs", async () => {
    const db = testDb.db;
    await db
      .insertInto("snapshot_blob")
      .values([
        { content: Buffer.from("a"), hash: "hash-only-old" },
        { content: Buffer.from("b"), hash: "hash-shared" },
        { content: Buffer.from("c"), hash: "hash-only-new" },
      ])
      .execute();
    await db
      .insertInto("snapshot_commit")
      .values([
        {
          commit_sha: "old-sha",
          created_at: OLD_CREATED_AT,
          file_count: 1,
          project_id: 1,
        },
        {
          commit_sha: "new-sha",
          created_at: NEW_CREATED_AT,
          file_count: 2,
          project_id: 1,
        },
      ])
      .execute();
    await db
      .insertInto("snapshot_entry")
      .values([
        {
          blob_hash: "hash-only-old",
          commit_sha: "old-sha",
          file_path: "a.ts",
          project_id: 1,
        },
        {
          blob_hash: "hash-shared",
          commit_sha: "old-sha",
          file_path: "shared.ts",
          project_id: 1,
        },
        {
          blob_hash: "hash-shared",
          commit_sha: "new-sha",
          file_path: "shared.ts",
          project_id: 1,
        },
        {
          blob_hash: "hash-only-new",
          commit_sha: "new-sha",
          file_path: "b.ts",
          project_id: 1,
        },
      ])
      .execute();
    const deleted = await repo.deleteOldSnapshotsBefore(CUTOFF);
    expect(deleted).toBe(1);
    const commits = await db
      .selectFrom("snapshot_commit")
      .selectAll()
      .execute();
    expect(commits.map((c) => c.commit_sha).sort()).toEqual(["new-sha"]);
    const entries = await db.selectFrom("snapshot_entry").selectAll().execute();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.blob_hash))).toEqual(
      new Set(["hash-only-new", "hash-shared"]),
    );
    const blobs = await db.selectFrom("snapshot_blob").select("hash").execute();
    expect(blobs.map((b) => b.hash).sort()).toEqual([
      "hash-only-new",
      "hash-shared",
    ]);
  });

  it("deleteOldSnapshotsBefore skips commits referenced by a fresh baseline_state", async () => {
    const db = testDb.db;
    await db
      .insertInto("snapshot_blob")
      .values({ content: Buffer.from("x"), hash: "h1" })
      .execute();
    await db
      .insertInto("snapshot_commit")
      .values({
        commit_sha: "baseline-sha",
        created_at: OLD_CREATED_AT,
        file_count: 1,
        project_id: 99,
      })
      .execute();
    await db
      .insertInto("snapshot_entry")
      .values({
        blob_hash: "h1",
        commit_sha: "baseline-sha",
        file_path: "f.ts",
        project_id: 99,
      })
      .execute();
    await db
      .insertInto("baseline_state")
      .values({
        commit_sha: "baseline-sha",
        project_id: 99,
        status: "ready",
        updated_at: NEW_CREATED_AT,
      })
      .execute();
    const deleted = await repo.deleteOldSnapshotsBefore(CUTOFF);
    expect(deleted).toBe(0);
    const row = await db
      .selectFrom("snapshot_commit")
      .selectAll()
      .where("project_id", "=", 99)
      .executeTakeFirst();
    expect(row?.commit_sha).toBe("baseline-sha");
  });

  it("deleteOldSnapshotsBefore removes stale baseline_state, its snapshot, entries, and orphan blobs", async () => {
    const db = testDb.db;
    const staleUpdatedAt = new Date("2011-01-01T00:00:00.000Z");
    await db
      .insertInto("snapshot_blob")
      .values([
        { content: Buffer.from("stale"), hash: "h-stale-only" },
        { content: Buffer.from("shared"), hash: "h-shared" },
      ])
      .execute();
    await db
      .insertInto("snapshot_commit")
      .values([
        {
          commit_sha: "stale-baseline-sha",
          created_at: OLD_CREATED_AT,
          file_count: 2,
          project_id: 200,
        },
        {
          commit_sha: "other-sha",
          created_at: NEW_CREATED_AT,
          file_count: 1,
          project_id: 200,
        },
      ])
      .execute();
    await db
      .insertInto("snapshot_entry")
      .values([
        {
          blob_hash: "h-stale-only",
          commit_sha: "stale-baseline-sha",
          file_path: "only-stale.ts",
          project_id: 200,
        },
        {
          blob_hash: "h-shared",
          commit_sha: "stale-baseline-sha",
          file_path: "shared.ts",
          project_id: 200,
        },
        {
          blob_hash: "h-shared",
          commit_sha: "other-sha",
          file_path: "shared.ts",
          project_id: 200,
        },
      ])
      .execute();
    await db
      .insertInto("baseline_state")
      .values({
        commit_sha: "stale-baseline-sha",
        project_id: 200,
        status: "ready",
        updated_at: staleUpdatedAt,
      })
      .execute();
    const deleted = await repo.deleteOldSnapshotsBefore(CUTOFF);
    expect(deleted).toBe(1);
    const baselineRow = await db
      .selectFrom("baseline_state")
      .selectAll()
      .where("project_id", "=", 200)
      .executeTakeFirst();
    expect(baselineRow).toBeUndefined();
    const commits = await db
      .selectFrom("snapshot_commit")
      .select("commit_sha")
      .where("project_id", "=", 200)
      .execute();
    expect(commits.map((c) => c.commit_sha)).toEqual(["other-sha"]);
    const entries = await db
      .selectFrom("snapshot_entry")
      .select("blob_hash")
      .where("project_id", "=", 200)
      .execute();
    expect(entries.map((e) => e.blob_hash).sort()).toEqual(["h-shared"]);
    const blobs = await db.selectFrom("snapshot_blob").select("hash").execute();
    expect(blobs.map((b) => b.hash).sort()).toEqual(["h-shared"]);
  });

  it("deleteOldSnapshotsBefore return value sums stale-baseline commit deletes and other old commit deletes", async () => {
    const db = testDb.db;
    const staleUpdatedAt = new Date("2011-01-01T00:00:00.000Z");
    await db
      .insertInto("snapshot_blob")
      .values([
        { content: Buffer.from("a"), hash: "ha" },
        { content: Buffer.from("b"), hash: "hb" },
      ])
      .execute();
    await db
      .insertInto("snapshot_commit")
      .values([
        {
          commit_sha: "stale-base-sha",
          created_at: OLD_CREATED_AT,
          file_count: 1,
          project_id: 50,
        },
        {
          commit_sha: "orphan-old-sha",
          created_at: OLD_CREATED_AT,
          file_count: 1,
          project_id: 51,
        },
      ])
      .execute();
    await db
      .insertInto("snapshot_entry")
      .values([
        {
          blob_hash: "ha",
          commit_sha: "stale-base-sha",
          file_path: "a.ts",
          project_id: 50,
        },
        {
          blob_hash: "hb",
          commit_sha: "orphan-old-sha",
          file_path: "b.ts",
          project_id: 51,
        },
      ])
      .execute();
    await db
      .insertInto("baseline_state")
      .values({
        commit_sha: "stale-base-sha",
        project_id: 50,
        status: "ready",
        updated_at: staleUpdatedAt,
      })
      .execute();
    const deleted = await repo.deleteOldSnapshotsBefore(CUTOFF);
    expect(deleted).toBe(2);
    const commitShas = await db
      .selectFrom("snapshot_commit")
      .select("commit_sha")
      .execute();
    expect(commitShas).toHaveLength(0);
  });

  it("deleteOldSnapshotsBefore returns zero when no snapshot_commit is old enough", async () => {
    const db = testDb.db;
    await db
      .insertInto("snapshot_blob")
      .values({ content: Buffer.from("z"), hash: "hz" })
      .execute();
    await db
      .insertInto("snapshot_commit")
      .values({
        commit_sha: "recent-sha",
        created_at: NEW_CREATED_AT,
        file_count: 1,
        project_id: 2,
      })
      .execute();
    await db
      .insertInto("snapshot_entry")
      .values({
        blob_hash: "hz",
        commit_sha: "recent-sha",
        file_path: "z.ts",
        project_id: 2,
      })
      .execute();
    const deleted = await repo.deleteOldSnapshotsBefore(CUTOFF);
    expect(deleted).toBe(0);
    const commits = await db
      .selectFrom("snapshot_commit")
      .selectAll()
      .execute();
    expect(commits).toHaveLength(1);
  });
});
