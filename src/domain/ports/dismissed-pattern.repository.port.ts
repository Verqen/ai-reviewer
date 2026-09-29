import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import type { FindingCategory, Severity } from "~/domain/types/review.types";

interface DismissedPattern {
  category: FindingCategory;
  createdAt: Date;
  createdBy?: string | undefined;
  filePathGlob?: string | undefined;
  id: string;
  occurrenceCount: number;
  patternDescription: string;
  projectId: number;
  ruleId?: RuleId | undefined;
  sampleComment?: string | undefined;
  sampleReply?: string | undefined;
  severity: Severity;
  updatedAt: Date;
}

interface CreateDismissedPatternInput {
  category: FindingCategory;
  createdBy?: string | undefined;
  filePathGlob?: string | undefined;
  patternDescription: string;
  projectId: number;
  ruleId: RuleId;
  sampleComment?: string | undefined;
  sampleReply?: string | undefined;
  severity: Severity;
}

interface IDismissedPatternRepository {
  create(input: CreateDismissedPatternInput): Promise<DismissedPattern>;
  findByProject(projectId: number): Promise<DismissedPattern[]>;
  findByRule(
    projectId: number,
    ruleId: RuleId,
  ): Promise<DismissedPattern | undefined>;
  incrementOccurrence(id: string): Promise<void>;
}

export type {
  CreateDismissedPatternInput,
  DismissedPattern,
  IDismissedPatternRepository,
};
