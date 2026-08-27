import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";

import { InjectionTokens } from "~/di/injection-tokens";
import type {
  BaselineState,
  ContentMatch,
  ISnapshotRepository,
} from "~/domain/ports/snapshot.repository.port";
import {
  SNAPSHOT_LIST_FILES_MAX_ROWS,
  SNAPSHOT_SEARCH_CONTENT_MAX_ROWS,
} from "~/domain/ports/snapshot.repository.port";
import type { PackageRootsInsight } from "~/domain/types/package-roots.types";
import {
  filePathGlobPatternHasMagic,
  getFilePathGlobPosixRegexSource,
  normalizeFilePathForGlob,
} from "~/glob/match-file-path-glob";
import type { Database } from "~/infrastructure/database/types";
import { collectLineNumberedMatches } from "~/search/collect-line-numbered-matches";

const BLOB_BATCH_SIZE = 100;
const PACKAGE_ROOT_SCAN_ROWS_LIMIT = 512;

class SnapshotRepository implements ISnapshotRepository {
  static inject = [InjectionTokens.Database] as const;

  constructor(private readonly db: Kysely<Database>) {}

  async storeBlobs(
    blobs: Array<{ hash: string; content: Buffer }>,
  ): Promise<void> {
    for (let i = 0; i < blobs.length; i += BLOB_BATCH_SIZE) {
      const batch = blobs.slice(i, i + BLOB_BATCH_SIZE);

      await this.db
        .insertInto("snapshot_blob")
        .values(batch.map((b) => ({ content: b.content, hash: b.hash })))
        .onConflict((oc) => oc.column("hash").doNothing())
        .execute();
    }
  }

  async storeSnapshot(params: {
    commitSha: string;
    entries: Array<{ blobHash: string; filePath: string }>;
    projectId: number;
  }): Promise<void> {
    const { commitSha, entries, projectId } = params;

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("snapshot_commit")
        .values({
          commit_sha: commitSha,
          file_count: entries.length,
          project_id: projectId,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "commit_sha"]).doUpdateSet({
            file_count: entries.length,
          }),
        )
        .execute();

      if (entries.length === 0) {
        return;
      }

      for (let i = 0; i < entries.length; i += BLOB_BATCH_SIZE) {
        const batch = entries.slice(i, i + BLOB_BATCH_SIZE);

        await trx
          .insertInto("snapshot_entry")
          .values(
            batch.map((e) => ({
              blob_hash: e.blobHash,
              commit_sha: commitSha,
              file_path: e.filePath,
              project_id: projectId,
            })),
          )
          .onConflict((oc) =>
            oc
              .columns(["project_id", "commit_sha", "file_path"])
              .doUpdateSet((eb) => ({
                blob_hash: eb.ref("excluded.blob_hash"),
              })),
          )
          .execute();
      }
    });
  }

  async getFileContent(
    projectId: number,
    commitSha: string,
    filePath: string,
  ): Promise<string | null> {
    const result = await this.db
      .selectFrom("snapshot_entry")
      .innerJoin(
        "snapshot_blob",
        "snapshot_blob.hash",
        "snapshot_entry.blob_hash",
      )
      .select(
        sql<string>`convert_from(snapshot_blob.content, 'UTF8')`.as("text"),
      )
      .where("snapshot_entry.project_id", "=", projectId)
      .where("snapshot_entry.commit_sha", "=", commitSha)
      .where("snapshot_entry.file_path", "=", filePath)
      .executeTakeFirst();

    return result?.text ?? null;
  }

  async listPackageRootsFromSnapshot(
    projectId: number,
    commitSha: string,
  ): Promise<PackageRootsInsight> {
    const [hasTopLevelRow, rootRows] = await Promise.all([
      sql<{ hasTopLevelSrcTree: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM snapshot_entry
          WHERE snapshot_entry.project_id = ${projectId}
            AND snapshot_entry.commit_sha = ${commitSha}
            AND snapshot_entry.file_path LIKE 'src/%'
        ) AS "hasTopLevelSrcTree"
      `.execute(this.db),
      sql<{ root_path: string; uses_src_layout: boolean }>`
        WITH raw_roots AS (
          SELECT regexp_replace(snapshot_entry.file_path, '(^|/)package\\.json$', '') AS root_path
          FROM snapshot_entry
          WHERE snapshot_entry.project_id = ${projectId}
            AND snapshot_entry.commit_sha = ${commitSha}
            AND (
              snapshot_entry.file_path LIKE '%/package.json'
              OR snapshot_entry.file_path = 'package.json'
            )
        ),
        clean_roots AS (
          SELECT DISTINCT root_path FROM raw_roots
          WHERE root_path IS NOT NULL AND root_path <> ''
          AND root_path NOT LIKE '%node_modules%'
        ),
        flagged AS (
          SELECT
            clean_roots.root_path,
            EXISTS (
              SELECT 1 FROM snapshot_entry e
              WHERE e.project_id = ${projectId}
              AND e.commit_sha = ${commitSha}
              AND starts_with(e.file_path, CONCAT(clean_roots.root_path, '/src/'))
            ) AS uses_src_layout
          FROM clean_roots
        )
        SELECT root_path, uses_src_layout
        FROM flagged
        ORDER BY root_path ASC
        LIMIT ${PACKAGE_ROOT_SCAN_ROWS_LIMIT}
      `.execute(this.db),
    ]);
    const hasTopLevelSrcTree = Boolean(
      hasTopLevelRow.rows[0]?.hasTopLevelSrcTree,
    );
    const roots: string[] = [];
    const usingSrcList: string[] = [];
    for (const row of rootRows.rows) {
      roots.push(row.root_path);
      if (row.uses_src_layout === true) {
        usingSrcList.push(row.root_path);
      }
    }
    return {
      hasTopLevelSrcTree,
      packageRoots: roots,
      packageRootsUsingSrc: usingSrcList,
    };
  }

  async listFiles(
    projectId: number,
    commitSha: string,
    pattern?: string,
    maxRows: number = SNAPSHOT_LIST_FILES_MAX_ROWS,
  ): Promise<string[]> {
    let query = this.db
      .selectFrom("snapshot_entry")
      .select("file_path")
      .where("project_id", "=", projectId)
      .where("commit_sha", "=", commitSha);

    if (pattern) {
      if (!filePathGlobPatternHasMagic(pattern)) {
        query = query.where(
          sql<SqlBool>`starts_with(file_path, ${normalizeFilePathForGlob(pattern)})`,
        );
      } else {
        const regexSource = getFilePathGlobPosixRegexSource(pattern);
        if (regexSource === null) {
          query = query.where(sql<SqlBool>`false`);
        } else {
          query = query.where(sql<SqlBool>`file_path ~ ${regexSource}`);
        }
      }
    }

    const rows = await query
      .orderBy("file_path", "asc")
      .limit(maxRows)
      .execute();

    return rows.map((r) => r.file_path);
  }

  async searchContent(
    projectId: number,
    commitSha: string,
    pattern: string,
    glob?: string,
    maxRows: number = SNAPSHOT_SEARCH_CONTENT_MAX_ROWS,
  ): Promise<ContentMatch[]> {
    let matchingEntries = this.db
      .selectFrom("snapshot_entry")
      .innerJoin(
        "snapshot_blob",
        "snapshot_blob.hash",
        "snapshot_entry.blob_hash",
      )
      .select(["snapshot_entry.file_path", "snapshot_entry.blob_hash"])
      .where("snapshot_entry.project_id", "=", projectId)
      .where("snapshot_entry.commit_sha", "=", commitSha)
      .where(
        sql<SqlBool>`position(convert_to(${pattern}::text, 'UTF8') in snapshot_blob.content) > 0`,
      );

    if (glob) {
      if (!filePathGlobPatternHasMagic(glob)) {
        matchingEntries = matchingEntries.where(
          sql<SqlBool>`starts_with(snapshot_entry.file_path, ${normalizeFilePathForGlob(glob)})`,
        );
      } else {
        const regexSource = getFilePathGlobPosixRegexSource(glob);
        if (regexSource === null) {
          matchingEntries = matchingEntries.where(sql<SqlBool>`false`);
        } else {
          matchingEntries = matchingEntries.where(
            sql<SqlBool>`snapshot_entry.file_path ~ ${regexSource}`,
          );
        }
      }
    }

    const rows = await this.db
      .selectFrom(
        matchingEntries
          .orderBy("snapshot_entry.file_path", "asc")
          .limit(maxRows)
          .as("matched_entry"),
      )
      .innerJoin(
        "snapshot_blob",
        "snapshot_blob.hash",
        "matched_entry.blob_hash",
      )
      .select([
        "matched_entry.file_path",
        sql<string>`convert_from(snapshot_blob.content, 'UTF8')`.as("text"),
      ])
      .orderBy("matched_entry.file_path", "asc")
      .execute();

    return rows.map((row) => ({
      filePath: row.file_path,
      matches: collectLineNumberedMatches(row.text, pattern),
    }));
  }

  async getBaselineState(projectId: number): Promise<BaselineState | null> {
    const row = await this.db
      .selectFrom("baseline_state")
      .selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      commitSha: row.commit_sha,
      errorMessage: row.error_message,
      status: row.status,
    };
  }

  async setBaselineState(
    projectId: number,
    commitSha: string,
    status: BaselineState["status"],
    errorMessage?: string,
  ): Promise<void> {
    await this.db
      .insertInto("baseline_state")
      .values({
        commit_sha: commitSha,
        error_message: errorMessage ?? null,
        project_id: projectId,
        status,
      })
      .onConflict((oc) =>
        oc.column("project_id").doUpdateSet({
          commit_sha: commitSha,
          error_message: errorMessage ?? null,
          status,
          updated_at: sql`NOW()`,
        }),
      )
      .execute();
  }

  async copySnapshotEntries(
    projectId: number,
    fromSha: string,
    toSha: string,
    excludePaths?: Set<string>,
  ): Promise<number> {
    const excluded = excludePaths ? [...excludePaths] : [];
    const result = await sql<{ copied_count: number }>`
      WITH source_entry AS (
        SELECT file_path, blob_hash
        FROM snapshot_entry
        WHERE project_id = ${projectId}
          AND commit_sha = ${fromSha}
          AND file_path <> ALL (${excluded}::TEXT[])
      ),
      inserted_entry AS (
        INSERT INTO snapshot_entry (project_id, commit_sha, file_path, blob_hash)
        SELECT ${projectId}::INTEGER, ${toSha}::TEXT, file_path, blob_hash
        FROM source_entry
        ON CONFLICT (project_id, commit_sha, file_path) DO NOTHING
      )
      SELECT COUNT(*)::INTEGER AS copied_count FROM source_entry
    `.execute(this.db);

    return result.rows[0]?.copied_count ?? 0;
  }

  async deleteCommit(projectId: number, commitSha: string): Promise<void> {
    await this.db
      .deleteFrom("snapshot_commit")
      .where("project_id", "=", projectId)
      .where("commit_sha", "=", commitSha)
      .execute();
  }

  async deleteOldSnapshotsBefore(now: Date): Promise<number> {
    return await this.db.transaction().execute(async (trx) => {
      const deleteStaleBaselineCommitsResult = await trx
        .deleteFrom("snapshot_commit")
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("baseline_state")
              .select("project_id")
              .whereRef(
                "baseline_state.project_id",
                "=",
                "snapshot_commit.project_id",
              )
              .whereRef(
                "baseline_state.commit_sha",
                "=",
                "snapshot_commit.commit_sha",
              )
              .where("baseline_state.updated_at", "<", now),
          ),
        )
        .executeTakeFirst();
      const deletedStaleBaselineCommits = Number(
        deleteStaleBaselineCommitsResult.numDeletedRows ?? 0n,
      );
      await trx
        .deleteFrom("baseline_state")
        .where("updated_at", "<", now)
        .execute();
      const deleteOldCommitsResult = await trx
        .deleteFrom("snapshot_commit")
        .where("created_at", "<", now)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("baseline_state")
                .select("project_id")
                .whereRef(
                  "baseline_state.project_id",
                  "=",
                  "snapshot_commit.project_id",
                )
                .whereRef(
                  "baseline_state.commit_sha",
                  "=",
                  "snapshot_commit.commit_sha",
                ),
            ),
          ),
        )
        .executeTakeFirst();
      const deletedOldCommits = Number(
        deleteOldCommitsResult.numDeletedRows ?? 0n,
      );
      await this.deleteOrphanSnapshotBlobs(trx);
      return deletedStaleBaselineCommits + deletedOldCommits;
    });
  }

  private async deleteOrphanSnapshotBlobs(db: Kysely<Database>): Promise<void> {
    await db
      .deleteFrom("snapshot_blob")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("snapshot_entry")
              .select("blob_hash")
              .whereRef("snapshot_entry.blob_hash", "=", "snapshot_blob.hash"),
          ),
        ),
      )
      .execute();
  }
}

export { SnapshotRepository };
