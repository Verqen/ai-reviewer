import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE review_finding ADD COLUMN rule_id TEXT`.execute(db);
  await sql`
    CREATE FUNCTION review_finding_require_rule_id() RETURNS trigger AS $$
    BEGIN
      IF NEW.rule_id IS NULL THEN
        RAISE EXCEPTION 'review_finding_rule_id_required' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER review_finding_rule_id_required
    BEFORE INSERT ON review_finding
    FOR EACH ROW EXECUTE FUNCTION review_finding_require_rule_id()
  `.execute(db);
  await sql`ALTER TABLE review_finding DROP COLUMN suggestion`.execute(db);
  await sql`ALTER TABLE dismissed_pattern ADD COLUMN rule_id TEXT`.execute(db);
  await sql`
    CREATE FUNCTION dismissed_pattern_require_rule_id() RETURNS trigger AS $$
    BEGIN
      IF NEW.rule_id IS NULL THEN
        RAISE EXCEPTION 'dismissed_pattern_rule_id_required' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER dismissed_pattern_rule_id_required
    BEFORE INSERT ON dismissed_pattern
    FOR EACH ROW EXECUTE FUNCTION dismissed_pattern_require_rule_id()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER dismissed_pattern_rule_id_required ON dismissed_pattern`.execute(
    db,
  );
  await sql`DROP FUNCTION dismissed_pattern_require_rule_id()`.execute(db);
  await sql`ALTER TABLE dismissed_pattern DROP COLUMN rule_id`.execute(db);
  await sql`ALTER TABLE review_finding ADD COLUMN suggestion TEXT`.execute(db);
  await sql`DROP TRIGGER review_finding_rule_id_required ON review_finding`.execute(
    db,
  );
  await sql`DROP FUNCTION review_finding_require_rule_id()`.execute(db);
  await sql`ALTER TABLE review_finding DROP COLUMN rule_id`.execute(db);
}
