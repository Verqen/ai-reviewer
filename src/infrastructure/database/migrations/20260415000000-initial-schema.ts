import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE review_status AS ENUM ('queued', 'in_progress', 'completed', 'failed')
  `.execute(db);

  await sql`
    CREATE TYPE severity AS ENUM ('critical', 'warning', 'info', 'nitpick')
  `.execute(db);

  await sql`
    CREATE TYPE finding_category AS ENUM (
      'bug', 'security', 'performance', 'architecture',
      'style', 'best_practice', 'data_consistency'
    )
  `.execute(db);

  await sql`
    CREATE TYPE comment_resolution AS ENUM ('pending', 'addressed', 'dismissed', 'wont_fix')
  `.execute(db);

  await sql`
    CREATE TYPE trigger_type AS ENUM (
      'mr_open', 'mr_undraft', 'push', 'force_push', 'main_push', 'mention'
    )
  `.execute(db);

  await sql`
    CREATE TYPE line_type AS ENUM ('added', 'removed', 'context')
  `.execute(db);

  await sql`
    CREATE TABLE review_run (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id INTEGER NOT NULL,
      mr_iid INTEGER NOT NULL,
      head_commit_sha TEXT NOT NULL,
      base_commit_sha TEXT NOT NULL,
      previous_run_id UUID REFERENCES review_run(id) ON DELETE SET NULL,
      status review_status NOT NULL DEFAULT 'queued',
      is_incremental BOOLEAN NOT NULL DEFAULT FALSE,
      trigger_type trigger_type NOT NULL,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      files_reviewed INTEGER,
      total_findings INTEGER,
      critical_count INTEGER,
      warning_count INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_cost DOUBLE PRECISION,
      triage_model TEXT,
      review_model TEXT,
      config_snapshot JSONB,
      error_message TEXT,
      UNIQUE (project_id, mr_iid, head_commit_sha, base_commit_sha, trigger_type)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_review_run_project_mr ON review_run (project_id, mr_iid)
  `.execute(db);

  await sql`
    CREATE INDEX idx_review_run_status ON review_run (status)
  `.execute(db);

  await sql`
    CREATE TABLE review_finding (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      review_run_id UUID NOT NULL REFERENCES review_run(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      old_path TEXT,
      line_number INTEGER NOT NULL,
      line_type line_type NOT NULL,
      line_excerpt TEXT,
      hunk_header TEXT,
      end_line_number INTEGER,
      severity severity NOT NULL,
      category finding_category NOT NULL,
      comment TEXT NOT NULL,
      suggestion TEXT,
      original_snippet TEXT,
      confidence DOUBLE PRECISION NOT NULL,
      host_discussion_id TEXT,
      host_note_id TEXT,
      resolution comment_resolution NOT NULL DEFAULT 'pending',
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      dismiss_reason TEXT,
      pass_name TEXT NOT NULL,
      model TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_review_finding_run_id ON review_finding (review_run_id)
  `.execute(db);

  await sql`
    CREATE INDEX idx_review_finding_resolution ON review_finding (resolution)
  `.execute(db);

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

  await sql`
    CREATE TABLE dismissed_pattern (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id INTEGER NOT NULL,
      pattern_description TEXT NOT NULL,
      category finding_category NOT NULL,
      severity severity NOT NULL,
      file_path_glob TEXT,
      sample_comment TEXT,
      sample_reply TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_dismissed_pattern_project ON dismissed_pattern (project_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS dismissed_pattern`.execute(db);
  await sql`DROP TABLE IF EXISTS codebase_index`.execute(db);
  await sql`DROP TABLE IF EXISTS review_finding`.execute(db);
  await sql`DROP TABLE IF EXISTS review_run`.execute(db);
  await sql`DROP TYPE IF EXISTS line_type`.execute(db);
  await sql`DROP TYPE IF EXISTS trigger_type`.execute(db);
  await sql`DROP TYPE IF EXISTS comment_resolution`.execute(db);
  await sql`DROP TYPE IF EXISTS finding_category`.execute(db);
  await sql`DROP TYPE IF EXISTS severity`.execute(db);
  await sql`DROP TYPE IF EXISTS review_status`.execute(db);
}
