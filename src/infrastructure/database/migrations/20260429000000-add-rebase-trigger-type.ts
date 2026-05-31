import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TYPE trigger_type
    ADD VALUE IF NOT EXISTS 'rebase' AFTER 'force_push'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TYPE trigger_type RENAME TO trigger_type_old`.execute(db);
  await sql`
    CREATE TYPE trigger_type AS ENUM (
      'mr_open', 'mr_undraft', 'push', 'force_push', 'main_push', 'mention'
    )
  `.execute(db);
  await sql`
    ALTER TABLE review_run
    ALTER COLUMN trigger_type TYPE trigger_type
    USING (
      CASE
        WHEN trigger_type::text = 'rebase' THEN 'force_push'::trigger_type
        ELSE trigger_type::text::trigger_type
      END
    )
  `.execute(db);
  await sql`DROP TYPE trigger_type_old`.execute(db);
}
