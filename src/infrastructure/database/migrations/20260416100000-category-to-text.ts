import type { Kysely } from "kysely";
import { sql } from "kysely";

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE review_finding ALTER COLUMN category TYPE TEXT USING category::TEXT
  `.execute(db);

  await sql`
    ALTER TABLE dismissed_pattern ALTER COLUMN category TYPE TEXT USING category::TEXT
  `.execute(db);

  await sql`DROP TYPE finding_category`.execute(db);
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE finding_category AS ENUM (
      'bug', 'security', 'performance', 'architecture',
      'style', 'best_practice', 'data_consistency'
    )
  `.execute(db);

  await sql`
    ALTER TABLE review_finding ALTER COLUMN category TYPE finding_category USING category::finding_category
  `.execute(db);

  await sql`
    ALTER TABLE dismissed_pattern ALTER COLUMN category TYPE finding_category USING category::finding_category
  `.execute(db);
}

export { down, up };
