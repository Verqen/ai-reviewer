import type { Kysely } from "kysely";

import { InjectionTokens } from "~/di/injection-tokens";
import type {
  CreateDismissedPatternInput,
  DismissedPattern,
  IDismissedPatternRepository,
} from "~/domain/ports/dismissed-pattern.repository.port";
import { toRuleId } from "~/domain/rule-catalog/rule-catalog";
import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import type { Severity } from "~/domain/types/review.types";
import type { Database } from "~/infrastructure/database/types";

function rowToDismissedPattern(row: {
  id: string;
  project_id: number;
  pattern_description: string;
  category: string;
  severity: string;
  file_path_glob: string | null;
  sample_comment: string | null;
  sample_reply: string | null;
  occurrence_count: number;
  created_by: string | null;
  rule_id: string | null;
  created_at: Date;
  updated_at: Date;
}): DismissedPattern {
  return {
    category: row.category,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    filePathGlob: row.file_path_glob ?? undefined,
    id: row.id,
    occurrenceCount: row.occurrence_count,
    patternDescription: row.pattern_description,
    projectId: row.project_id,
    ruleId: toRuleId(row.rule_id),
    sampleComment: row.sample_comment ?? undefined,
    sampleReply: row.sample_reply ?? undefined,
    severity: row.severity as Severity,
    updatedAt: row.updated_at,
  };
}

class DismissedPatternRepository implements IDismissedPatternRepository {
  static inject = [InjectionTokens.Database] as const;

  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateDismissedPatternInput): Promise<DismissedPattern> {
    const row = await this.db
      .insertInto("dismissed_pattern")
      .values({
        category: input.category,
        created_by: input.createdBy ?? null,
        file_path_glob: input.filePathGlob ?? null,
        pattern_description: input.patternDescription,
        project_id: input.projectId,
        rule_id: input.ruleId ?? null,
        sample_comment: input.sampleComment ?? null,
        sample_reply: input.sampleReply ?? null,
        severity: input.severity,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToDismissedPattern(row);
  }

  async findByProject(projectId: number): Promise<DismissedPattern[]> {
    const rows = await this.db
      .selectFrom("dismissed_pattern")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map(rowToDismissedPattern);
  }

  async findByRule(
    projectId: number,
    ruleId: RuleId,
  ): Promise<DismissedPattern | undefined> {
    const row = await this.db
      .selectFrom("dismissed_pattern")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("rule_id", "=", ruleId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(1)
      .executeTakeFirst();

    return row === undefined ? undefined : rowToDismissedPattern(row);
  }

  async incrementOccurrence(id: string): Promise<void> {
    await this.db
      .updateTable("dismissed_pattern")
      .set((eb) => ({
        occurrence_count: eb("occurrence_count", "+", 1),
        updated_at: new Date(),
      }))
      .where("id", "=", id)
      .execute();
  }
}

export { DismissedPatternRepository };
