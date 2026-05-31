import type { Kysely } from "kysely";

import { InjectionTokens } from "~/di/injection-tokens";
import type {
  CreateDismissedPatternInput,
  DismissedPattern,
  IDismissedPatternRepository,
} from "~/domain/ports/dismissed-pattern.repository.port";
import type { FindingCategory, Severity } from "~/domain/types/review.types";
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

  async findSimilar(
    projectId: number,
    category: FindingCategory,
    comment: string,
  ): Promise<DismissedPattern | undefined> {
    const rows = await this.db
      .selectFrom("dismissed_pattern")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("category", "=", category)
      .execute();

    const normalizedComment = comment.toLowerCase().trim();
    const commentWords = new Set(
      normalizedComment.split(/\s+/).filter((w) => w.length > 3),
    );

    let bestMatch: DismissedPattern | undefined;
    let bestOverlap = 0;

    for (const row of rows) {
      const patternWords = new Set(
        row.pattern_description
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );
      let overlap = 0;
      for (const word of commentWords) {
        if (patternWords.has(word)) {
          overlap++;
        }
      }
      const overlapRatio =
        commentWords.size > 0 ? overlap / commentWords.size : 0;
      if (overlapRatio >= 0.5 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = rowToDismissedPattern(row);
      }
    }

    return bestMatch;
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
