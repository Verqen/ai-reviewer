import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE baseline_status AS ENUM ('missing', 'bootstrapping', 'ready', 'failed')
  `.execute(db);

  await sql`
    CREATE TABLE snapshot_blob (
      hash TEXT PRIMARY KEY,
      content BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE TABLE snapshot_commit (
      project_id INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, commit_sha)
    )
  `.execute(db);

  await sql`
    CREATE TABLE snapshot_entry (
      project_id INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      blob_hash TEXT NOT NULL REFERENCES snapshot_blob(hash),
      PRIMARY KEY (project_id, commit_sha, file_path),
      FOREIGN KEY (project_id, commit_sha)
        REFERENCES snapshot_commit(project_id, commit_sha) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_snapshot_entry_blob ON snapshot_entry (blob_hash)
  `.execute(db);

  await sql`
    CREATE TABLE baseline_state (
      project_id INTEGER PRIMARY KEY,
      commit_sha TEXT NOT NULL,
      status baseline_status NOT NULL DEFAULT 'missing',
      error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`DROP TABLE codebase_index`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE baseline_state`.execute(db);
  await sql`DROP TABLE snapshot_entry`.execute(db);
  await sql`DROP TABLE snapshot_commit`.execute(db);
  await sql`DROP TABLE snapshot_blob`.execute(db);
  await sql`DROP TYPE baseline_status`.execute(db);

  await sql`
    CREATE TABLE codebase_index (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id INTEGER NOT NULL,
      commit_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      summary TEXT,
      imports JSONB NOT NULL DEFAULT '[]',
      exports JSONB NOT NULL DEFAULT '[]',
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, commit_sha, file_path)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_codebase_index_project_commit ON codebase_index (project_id, commit_sha)
  `.execute(db);
}
