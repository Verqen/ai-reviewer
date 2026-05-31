import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import type { LineType } from "~/domain/types/review.types";
import { getAnchorCatalogLineNumber } from "~/review/diff-parser";

const DEFAULT_DIFF_HUNK_CONTEXT_LINES = 8;
const MAX_DIFF_HUNK_CONTEXT_LINES = 40;
const HUNK_HEADER_RANGE_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type ResolveDiffHunkForAnchorOptions = {
  contextLines?: number | undefined;
};

type DiffHunkSpanResolutionFail = {
  error: string;
  kind: "error";
};

type DiffHunkSpanResolutionOk = {
  hunkHeader: string;
  kind: "ok";
  lineRanges: {
    headNewEndInclusive: number;
    headNewStartInclusive: number;
    oldEndInclusive: number;
    oldStartInclusive: number;
  };
};

type ResolveDiffHunkForAnchorResult =
  | DiffHunkSpanResolutionFail
  | DiffHunkSpanResolutionOk;

function parseHunkCountsFromHeader(header: string):
  | {
      newLen: number;
      newStart: number;
      oldLen: number;
      oldStart: number;
    }
  | undefined {
  const match = HUNK_HEADER_RANGE_REGEX.exec(header);
  if (!match) {
    return undefined;
  }
  const oldStart = Number(match[1]);
  const oldLen = Number(match[2] ?? "1");
  const newStart = Number(match[3]);
  const newLenValue = Number(match[4] ?? "1");
  const normOldLen = oldLen <= 0 ? 0 : oldLen;
  const normNewLen = newLenValue <= 0 ? 0 : newLenValue;
  return {
    newLen: normNewLen,
    newStart,
    oldLen: normOldLen,
    oldStart,
  };
}

function clampContextLines(raw: unknown): number {
  const value =
    typeof raw === "number" && Number.isInteger(raw)
      ? raw
      : DEFAULT_DIFF_HUNK_CONTEXT_LINES;
  return Math.min(Math.max(value, 0), MAX_DIFF_HUNK_CONTEXT_LINES);
}

function resolveDiffLinesSideRange(
  hunkLines: readonly DiffLine[],
  side: "new" | "old",
  fallback: { header: string },
): { max: number; min: number } | undefined {
  let minFound = Infinity;
  let maxFound = -Infinity;
  for (const line of hunkLines) {
    const n =
      side === "old"
        ? (line.oldLine ?? undefined)
        : (line.newLine ?? undefined);
    if (n === undefined) {
      continue;
    }
    minFound = Math.min(minFound, n);
    maxFound = Math.max(maxFound, n);
  }
  if (minFound !== Infinity && maxFound !== -Infinity) {
    return { max: maxFound, min: minFound };
  }
  const headerCounts = parseHunkCountsFromHeader(fallback.header);
  if (!headerCounts) {
    return undefined;
  }
  if (side === "old") {
    if (headerCounts.oldLen > 0) {
      const start = headerCounts.oldStart;
      return { max: start + headerCounts.oldLen - 1, min: start };
    }
    return { max: headerCounts.oldStart, min: headerCounts.oldStart };
  }
  if (headerCounts.newLen > 0) {
    const start = headerCounts.newStart;
    return { max: start + headerCounts.newLen - 1, min: start };
  }
  return { max: headerCounts.newStart, min: headerCounts.newStart };
}

function extendRangeWithContext(
  range: { max: number; min: number } | undefined,
  contextLines: number,
): { endInclusive: number; startInclusive: number } | undefined {
  if (range === undefined) {
    return undefined;
  }
  return {
    endInclusive: range.max + contextLines,
    startInclusive: Math.max(1, range.min - contextLines),
  };
}

function resolveDiffHunkForAnchor(
  parsed: ParsedFileDiff,
  anchorLineNumber: number,
  anchorLineType: LineType,
  options?: ResolveDiffHunkForAnchorOptions,
): ResolveDiffHunkForAnchorResult {
  const contextLines = clampContextLines(options?.contextLines);
  let anchorIndex = -1;
  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i]!;
    if (
      line.type === anchorLineType &&
      getAnchorCatalogLineNumber(line) === anchorLineNumber
    ) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) {
    return {
      error: `No diff line matched anchor ${anchorLineType} at line_number ${anchorLineNumber}.`,
      kind: "error",
    };
  }
  const anchorLine = parsed.lines[anchorIndex]!;
  const hunkHeader =
    anchorLine.hunkHeader.trim().length > 0
      ? anchorLine.hunkHeader
      : "(missing hunk header)";
  const hunkLines = parsed.lines.filter(
    (l) => l.hunkHeader === anchorLine.hunkHeader,
  );
  const oldExtent = resolveDiffLinesSideRange(hunkLines, "old", {
    header: anchorLine.hunkHeader,
  });
  const newExtent = resolveDiffLinesSideRange(hunkLines, "new", {
    header: anchorLine.hunkHeader,
  });
  const oldRangeExpanded = extendRangeWithContext(oldExtent, contextLines);
  const newRangeExpanded = extendRangeWithContext(newExtent, contextLines);
  if (oldRangeExpanded === undefined && newRangeExpanded === undefined) {
    return {
      error: `Could not derive line spans for hunk matching ${anchorLineType} at ${anchorLineNumber}.`,
      kind: "error",
    };
  }
  const fallbackStartInclusive = anchorLine.oldLine ?? anchorLine.newLine ?? 1;
  const oldStartInclusive =
    oldRangeExpanded?.startInclusive ?? fallbackStartInclusive;
  const oldEndInclusive = oldRangeExpanded?.endInclusive ?? oldStartInclusive;
  const fallbackNewStartInclusive =
    anchorLine.newLine ?? anchorLine.oldLine ?? 1;
  const headNewStartInclusive =
    newRangeExpanded?.startInclusive ?? fallbackNewStartInclusive;
  const headNewEndInclusive =
    newRangeExpanded?.endInclusive ?? headNewStartInclusive;
  return {
    hunkHeader,
    kind: "ok",
    lineRanges: {
      headNewEndInclusive,
      headNewStartInclusive,
      oldEndInclusive,
      oldStartInclusive,
    },
  };
}

export type {
  DiffHunkSpanResolutionFail,
  DiffHunkSpanResolutionOk,
  ResolveDiffHunkForAnchorOptions,
  ResolveDiffHunkForAnchorResult,
};
export { resolveDiffHunkForAnchor };
