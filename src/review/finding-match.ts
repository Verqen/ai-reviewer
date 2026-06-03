import type { LineType } from "~/domain/types/review.types";

interface MatchableFinding {
  category: string;
  filePath: string;
  lineNumber: number;
  lineType: LineType;
}

function normalizeCategory(value: string): string {
  return value.toLowerCase().trim();
}

function findingsMatch(
  left: MatchableFinding,
  right: MatchableFinding,
  tolerance: number,
): boolean {
  if (left.filePath !== right.filePath) {
    return false;
  }
  if (left.lineType !== right.lineType) {
    return false;
  }
  if (normalizeCategory(left.category) !== normalizeCategory(right.category)) {
    return false;
  }
  return Math.abs(left.lineNumber - right.lineNumber) <= tolerance;
}

export { findingsMatch, normalizeCategory };
export type { MatchableFinding };
