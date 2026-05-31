import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import type { LineType } from "~/domain/types/review.types";

interface FindingPositionInput {
  end_line?: number | null | undefined;
  line_number: number;
  line_type: string;
}

interface FindingPositionValidationResult {
  reason?: string | undefined;
  valid: boolean;
}

function resolveLineNumberForType(
  line: DiffLine,
  lineType: LineType,
): number | undefined {
  if (lineType === "removed") {
    return line.oldLine;
  }
  return line.newLine;
}

function findMatchingDiffLine(
  fileDiff: ParsedFileDiff,
  lineType: LineType,
  lineNumber: number,
): DiffLine | undefined {
  return fileDiff.lines.find(
    (line) =>
      line.type === lineType &&
      resolveLineNumberForType(line, lineType) === lineNumber,
  );
}

function validateFindingPositionInHunk(
  finding: FindingPositionInput,
  fileDiff: ParsedFileDiff,
): FindingPositionValidationResult {
  const lineType = finding.line_type as LineType;
  const startLine = finding.line_number;
  if (startLine <= 0) {
    return { reason: "line_number_non_positive", valid: false };
  }
  const start = findMatchingDiffLine(fileDiff, lineType, startLine);
  if (!start) {
    return { reason: "line_number_not_in_hunk", valid: false };
  }
  if (finding.end_line === null || finding.end_line === undefined) {
    return { valid: true };
  }
  const endLine = finding.end_line;
  if (endLine < startLine) {
    return { reason: "end_line_before_line_number", valid: false };
  }
  const end = findMatchingDiffLine(fileDiff, lineType, endLine);
  if (!end) {
    return { reason: "end_line_not_in_hunk", valid: false };
  }
  if (start.hunkHeader !== end.hunkHeader) {
    return { reason: "line_range_crosses_hunks", valid: false };
  }
  return { valid: true };
}

export type { FindingPositionInput, FindingPositionValidationResult };
export { findMatchingDiffLine, validateFindingPositionInHunk };
