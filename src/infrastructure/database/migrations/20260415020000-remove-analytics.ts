import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS review_analytics`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS review_analytics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id INTEGER NOT NULL,
      mr_iid INTEGER NOT NULL,
      author_username TEXT,
      total_findings INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      dismissed_count INTEGER NOT NULL DEFAULT 0,
      fixed_count INTEGER NOT NULL DEFAULT 0,
      category_breakdown JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, mr_iid)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_review_analytics_project ON review_analytics (project_id)
  `.execute(db);
}
