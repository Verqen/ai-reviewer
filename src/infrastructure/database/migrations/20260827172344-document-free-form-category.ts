import type { Kysely } from "kysely";
import { sql } from "kysely";

const FREE_FORM_CATEGORY_COMMENT =
  "Free-form vocabulary since 20260416100000-category-to-text; the finding_category enum was dropped and cannot be restored from arbitrary values";

const DROPPED_FINDING_CATEGORY_LABELS = [
  "bug",
  "security",
  "performance",
  "architecture",
  "style",
  "best_practice",
  "data_consistency",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    COMMENT ON COLUMN review_finding.category IS ${sql.lit(FREE_FORM_CATEGORY_COMMENT)}
  `.execute(db);

  await sql`
    COMMENT ON COLUMN dismissed_pattern.category IS ${sql.lit(FREE_FORM_CATEGORY_COMMENT)}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const unrestorable = await sql<{ category: string }>`
    SELECT DISTINCT category FROM review_finding
    WHERE category <> ALL (${DROPPED_FINDING_CATEGORY_LABELS}::TEXT[])
    UNION
    SELECT DISTINCT category FROM dismissed_pattern
    WHERE category <> ALL (${DROPPED_FINDING_CATEGORY_LABELS}::TEXT[])
    ORDER BY category
  `.execute(db);

  if (unrestorable.rows.length > 0) {
    const values = unrestorable.rows.map((row) => row.category).join(", ");
    throw new Error(
      `Refusing to roll back: 20260416100000-category-to-text cannot be reversed while category holds values outside the dropped finding_category enum (${values}). Roll forward with a new migration instead.`,
    );
  }

  await sql`COMMENT ON COLUMN review_finding.category IS NULL`.execute(db);
  await sql`COMMENT ON COLUMN dismissed_pattern.category IS NULL`.execute(db);
}
