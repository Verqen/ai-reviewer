import type { ReviewFinding } from "~/domain/types/review.types";

interface ForcePushCorrelationCandidate {
  finding: ReviewFinding;
  newLineNumber: number;
}

interface ForcePushCorrelationResult {
  addressed: string[];
  correlated: ForcePushCorrelationCandidate[];
  pending: string[];
}

interface ForcePushLineCorrelationPlan {
  correlated: ForcePushCorrelationCandidate[];
  findingsToMarkAddressed: ReviewFinding[];
  pendingFindingIds: string[];
}

interface ForcePushLineMatchOptions {
  lineMatchTabWidth: number;
  lineWindow: number;
}

export type {
  ForcePushCorrelationCandidate,
  ForcePushCorrelationResult,
  ForcePushLineCorrelationPlan,
  ForcePushLineMatchOptions,
};
