import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE review_run ALTER COLUMN status DROP DEFAULT`.execute(
    db,
  );
  await sql`ALTER TABLE review_run ALTER COLUMN is_incremental DROP DEFAULT`.execute(
    db,
  );
  await sql`ALTER TABLE review_finding ALTER COLUMN resolution DROP DEFAULT`.execute(
    db,
  );
  await sql`ALTER TABLE baseline_state ALTER COLUMN status DROP DEFAULT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE baseline_state ALTER COLUMN status SET DEFAULT 'missing'`.execute(
    db,
  );
  await sql`ALTER TABLE review_finding ALTER COLUMN resolution SET DEFAULT 'pending'`.execute(
    db,
  );
  await sql`ALTER TABLE review_run ALTER COLUMN is_incremental SET DEFAULT FALSE`.execute(
    db,
  );
  await sql`ALTER TABLE review_run ALTER COLUMN status SET DEFAULT 'queued'`.execute(
    db,
  );
}
