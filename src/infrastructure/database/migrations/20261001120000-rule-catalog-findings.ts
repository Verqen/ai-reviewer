import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE review_finding ADD COLUMN rule_id TEXT`.execute(db);
  await sql`
    ALTER TABLE review_finding
    ADD CONSTRAINT review_finding_rule_id_required CHECK (rule_id IS NOT NULL) NOT VALID
  `.execute(db);
  await sql`ALTER TABLE review_finding DROP COLUMN suggestion`.execute(db);
  await sql`ALTER TABLE dismissed_pattern ADD COLUMN rule_id TEXT`.execute(db);
  await sql`
    ALTER TABLE dismissed_pattern
    ADD CONSTRAINT dismissed_pattern_rule_id_required CHECK (rule_id IS NOT NULL) NOT VALID
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE dismissed_pattern DROP CONSTRAINT dismissed_pattern_rule_id_required`.execute(
    db,
  );
  await sql`ALTER TABLE dismissed_pattern DROP COLUMN rule_id`.execute(db);
  await sql`ALTER TABLE review_finding ADD COLUMN suggestion TEXT`.execute(db);
  await sql`ALTER TABLE review_finding DROP CONSTRAINT review_finding_rule_id_required`.execute(
    db,
  );
  await sql`ALTER TABLE review_finding DROP COLUMN rule_id`.execute(db);
}
