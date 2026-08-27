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
  it("returns non-ASCII file content unchanged", async () => {
    const content = 'const приветствие = "Привет, мир"; // 🚀 emoji\n';
    const contentBuffer = Buffer.from(content, "utf-8");

    await repo.storeBlobs([{ content: contentBuffer, hash: "hash-utf8" }]);
    await repo.storeSnapshot({
      commitSha: "sha-utf8",
      entries: [{ blobHash: "hash-utf8", filePath: "src/greeting.ts" }],
      projectId: 7,
    });

    const stored = await repo.getFileContent(7, "sha-utf8", "src/greeting.ts");

    expect(stored).toBe(content);
  });

  it("finds a non-ASCII needle through content search", async () => {
    const content = 'const приветствие = "Привет, мир";\n';
    await repo.storeBlobs([
      { content: Buffer.from(content, "utf-8"), hash: "hash-search" },
    ]);
    await repo.storeSnapshot({
      commitSha: "sha-search",
      entries: [{ blobHash: "hash-search", filePath: "src/greeting.ts" }],
      projectId: 7,
    });

    const matches = await repo.searchContent(7, "sha-search", "Привет");

    expect(matches.map((match) => match.filePath)).toEqual(["src/greeting.ts"]);
  });

  it("copySnapshotEntries copies every entry of a commit and reports the count", async () => {
    await repo.storeBlobs([
      { content: Buffer.from("a"), hash: "hash-a" },
      { content: Buffer.from("b"), hash: "hash-b" },
    ]);
    await repo.storeSnapshot({
      commitSha: "from-sha",
      entries: [
        { blobHash: "hash-a", filePath: "src/a.ts" },
        { blobHash: "hash-b", filePath: "src/b.ts" },
      ],
      projectId: 5,
    });
    await repo.storeSnapshot({
      commitSha: "to-sha",
      entries: [],
      projectId: 5,
    });

    const copied = await repo.copySnapshotEntries(5, "from-sha", "to-sha");

    expect(copied).toBe(2);
    await expect(repo.listFiles(5, "to-sha")).resolves.toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    await expect(repo.getFileContent(5, "to-sha", "src/b.ts")).resolves.toBe(
      "b",
    );
  });

  it("copySnapshotEntries skips excluded paths and counts only what it copies", async () => {
    await repo.storeBlobs([{ content: Buffer.from("a"), hash: "hash-a" }]);
    await repo.storeSnapshot({
      commitSha: "from-sha",
      entries: [
        { blobHash: "hash-a", filePath: "src/a.ts" },
        { blobHash: "hash-a", filePath: "src/b.ts" },
        { blobHash: "hash-a", filePath: "src/c.ts" },
      ],
      projectId: 5,
    });
    await repo.storeSnapshot({
      commitSha: "to-sha",
      entries: [],
      projectId: 5,
    });

    const copied = await repo.copySnapshotEntries(
      5,
      "from-sha",
      "to-sha",
      new Set(["src/b.ts"]),
    );

    expect(copied).toBe(2);
    await expect(repo.listFiles(5, "to-sha")).resolves.toEqual([
      "src/a.ts",
      "src/c.ts",
    ]);
  });

  it("copySnapshotEntries keeps entries that already exist at the target commit", async () => {
    await repo.storeBlobs([
      { content: Buffer.from("old"), hash: "hash-old" },
      { content: Buffer.from("new"), hash: "hash-new" },
    ]);
    await repo.storeSnapshot({
      commitSha: "from-sha",
      entries: [{ blobHash: "hash-old", filePath: "src/a.ts" }],
      projectId: 5,
    });
    await repo.storeSnapshot({
      commitSha: "to-sha",
      entries: [{ blobHash: "hash-new", filePath: "src/a.ts" }],
      projectId: 5,
    });

    const copied = await repo.copySnapshotEntries(5, "from-sha", "to-sha");

    expect(copied).toBe(1);
    await expect(repo.getFileContent(5, "to-sha", "src/a.ts")).resolves.toBe(
      "new",
    );
  });

  it("copySnapshotEntries reports zero for an empty source commit", async () => {
    await repo.storeSnapshot({
      commitSha: "from-sha",
      entries: [],
      projectId: 5,
    });
    await repo.storeSnapshot({
      commitSha: "to-sha",
      entries: [],
      projectId: 5,
    });

    await expect(
      repo.copySnapshotEntries(5, "from-sha", "to-sha"),
    ).resolves.toBe(0);
  });

  it("listFiles caps the returned rows at the requested maximum", async () => {
    await repo.storeBlobs([{ content: Buffer.from("x"), hash: "hash-x" }]);
    await repo.storeSnapshot({
      commitSha: "many-sha",
      entries: [
        { blobHash: "hash-x", filePath: "src/a.ts" },
        { blobHash: "hash-x", filePath: "src/b.ts" },
        { blobHash: "hash-x", filePath: "src/c.ts" },
      ],
      projectId: 6,
    });

    await expect(repo.listFiles(6, "many-sha", undefined, 2)).resolves.toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("searchContent caps the returned rows and stays ordered by path", async () => {
    await repo.storeBlobs([
      { content: Buffer.from("needle here\n"), hash: "hash-1" },
      { content: Buffer.from("needle there\n"), hash: "hash-2" },
      { content: Buffer.from("needle everywhere\n"), hash: "hash-3" },
    ]);
    await repo.storeSnapshot({
      commitSha: "search-sha",
      entries: [
        { blobHash: "hash-1", filePath: "src/a.ts" },
        { blobHash: "hash-2", filePath: "src/b.ts" },
        { blobHash: "hash-3", filePath: "src/c.ts" },
      ],
      projectId: 6,
    });

    const capped = await repo.searchContent(
      6,
      "search-sha",
      "needle",
      undefined,
      2,
    );

    expect(capped.map((match) => match.filePath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(capped[0]?.matches).toEqual(["1:needle here"]);
  });

  it("searchContent matches the pattern literally, not as a LIKE wildcard", async () => {
    await repo.storeBlobs([
      { content: Buffer.from("const rate = 10%;\n"), hash: "hash-literal" },
      { content: Buffer.from("const other = 10;\n"), hash: "hash-plain" },
    ]);
    await repo.storeSnapshot({
      commitSha: "literal-sha",
      entries: [
        { blobHash: "hash-literal", filePath: "src/literal.ts" },
        { blobHash: "hash-plain", filePath: "src/plain.ts" },
      ],
      projectId: 6,
    });

    const matches = await repo.searchContent(6, "literal-sha", "10%");

    expect(matches.map((match) => match.filePath)).toEqual(["src/literal.ts"]);
  });

  it("searchContent restricts results to the requested glob", async () => {
    await repo.storeBlobs([
      { content: Buffer.from("needle\n"), hash: "hash-in" },
      { content: Buffer.from("needle\n"), hash: "hash-out" },
    ]);
    await repo.storeSnapshot({
      commitSha: "glob-sha",
      entries: [
        { blobHash: "hash-in", filePath: "src/in.ts" },
        { blobHash: "hash-out", filePath: "docs/out.md" },
      ],
      projectId: 6,
    });

    const matches = await repo.searchContent(
      6,
      "glob-sha",
      "needle",
      "src/**/*.ts",
    );

    expect(matches.map((match) => match.filePath)).toEqual(["src/in.ts"]);
  });

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
