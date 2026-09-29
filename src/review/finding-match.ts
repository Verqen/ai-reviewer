import type { LineType } from "~/domain/types/review.types";

interface MatchableFinding {
  filePath: string;
  lineNumber: number;
  lineType: LineType;
  ruleId?: string | undefined;
}

function findingsMatch(
  left: MatchableFinding,
  right: MatchableFinding,
  tolerance: number,
): boolean {
  if (left.ruleId === undefined || right.ruleId === undefined) return false;
  if (left.ruleId !== right.ruleId) return false;
  if (left.filePath !== right.filePath) return false;
  if (left.lineType !== right.lineType) return false;
  return Math.abs(left.lineNumber - right.lineNumber) <= tolerance;
}

export { findingsMatch };
export type { MatchableFinding };
