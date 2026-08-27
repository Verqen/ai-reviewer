import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TYPE severity
    ADD VALUE 'attention' BEFORE 'warning'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TYPE severity RENAME TO severity_old`.execute(db);
  await sql`
    CREATE TYPE severity AS ENUM ('critical', 'warning', 'info', 'nitpick')
  `.execute(db);
  await sql`
    ALTER TABLE review_finding
    ALTER COLUMN severity TYPE severity
    USING (
      CASE
        WHEN severity::text = 'attention' THEN 'warning'::severity
        ELSE severity::text::severity
      END
    )
  `.execute(db);
  await sql`
    ALTER TABLE dismissed_pattern
    ALTER COLUMN severity TYPE severity
    USING (
      CASE
        WHEN severity::text = 'attention' THEN 'warning'::severity
        ELSE severity::text::severity
      END
    )
  `.execute(db);
  await sql`DROP TYPE severity_old`.execute(db);
}
