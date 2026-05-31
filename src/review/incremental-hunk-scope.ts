import type { DiffFile } from "~/domain/types/code-host.types";
import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import { parseDiff } from "~/review/diff-parser";

interface LineRange {
  max: number;
  min: number;
}

interface HunkShape {
  header: string;
  lines: DiffLine[];
  newRange?: LineRange | undefined;
  oldRange?: LineRange | undefined;
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function rangesOverlap(left: LineRange, right: LineRange): boolean {
  return left.min <= right.max && right.min <= left.max;
}

function areRangesOverlapping(left?: LineRange, right?: LineRange): boolean {
  if (!left || !right) {
    return false;
  }
  return rangesOverlap(left, right);
}

function parseRangeFromHeader(
  header: string,
  side: "new" | "old",
): LineRange | undefined {
  const match = HUNK_HEADER_REGEX.exec(header);
  if (!match) {
    return undefined;
  }
  const start = Number(side === "old" ? match[1] : match[3]);
  const countRaw = side === "old" ? match[2] : match[4];
  const count = Number(countRaw ?? "1");
  const normalizedCount = count > 0 ? count : 1;
  return {
    max: start + normalizedCount - 1,
    min: start,
  };
}

function isSamePath(left: string, right: string): boolean {
  return left.length > 0 && left === right;
}

function areDiffFilesRelated(delta: DiffFile, mr: DiffFile): boolean {
  return (
    isSamePath(delta.newPath, mr.newPath) ||
    isSamePath(delta.newPath, mr.oldPath) ||
    isSamePath(delta.oldPath, mr.newPath) ||
    isSamePath(delta.oldPath, mr.oldPath)
  );
}

function groupHunks(parsed: ParsedFileDiff): HunkShape[] {
  const hunks: HunkShape[] = [];
  let current: HunkShape | null = null;
  for (const line of parsed.lines) {
    if (current === null || current.header !== line.hunkHeader) {
      current = {
        header: line.hunkHeader,
        lines: [],
        newRange: parseRangeFromHeader(line.hunkHeader, "new"),
        oldRange: parseRangeFromHeader(line.hunkHeader, "old"),
      };
      hunks.push(current);
    }
    current.lines.push(line);
  }
  return hunks;
}

function hasHunkOverlap(deltaHunk: HunkShape, mrHunk: HunkShape): boolean {
  if (deltaHunk.header === mrHunk.header) {
    return true;
  }
  if (areRangesOverlapping(deltaHunk.newRange, mrHunk.newRange)) {
    return true;
  }
  return areRangesOverlapping(deltaHunk.oldRange, mrHunk.oldRange);
}

function renderLine(line: DiffLine): string {
  if (line.type === "added") {
    return `+${line.content}`;
  }
  if (line.type === "removed") {
    return `-${line.content}`;
  }
  return ` ${line.content}`;
}

function renderHunks(hunks: readonly HunkShape[]): string {
  const parts: string[] = [];
  for (const hunk of hunks) {
    parts.push(hunk.header);
    for (const line of hunk.lines) {
      parts.push(renderLine(line));
    }
  }
  return parts.join("\n");
}

function scopeDeltaDiffsToMrHunks(
  deltaDiffs: readonly DiffFile[],
  mrDiffs: readonly DiffFile[],
): DiffFile[] {
  const parsedMrByIndex = mrDiffs.map((diff) => ({
    diff,
    hunks: groupHunks(parseDiff(diff)),
  }));
  const scoped: DiffFile[] = [];
  for (const deltaDiff of deltaDiffs) {
    const relatedMr = parsedMrByIndex.filter((entry) =>
      areDiffFilesRelated(deltaDiff, entry.diff),
    );
    if (relatedMr.length === 0) {
      continue;
    }
    const deltaHunks = groupHunks(parseDiff(deltaDiff));
    const relatedMrHunks = relatedMr.flatMap((entry) => entry.hunks);
    const overlappingDeltaHunks = deltaHunks.filter((deltaHunk) =>
      relatedMrHunks.some((mrHunk) => hasHunkOverlap(deltaHunk, mrHunk)),
    );
    if (overlappingDeltaHunks.length === 0) {
      continue;
    }
    const scopedDiff = renderHunks(overlappingDeltaHunks);
    if (scopedDiff.length === 0) {
      continue;
    }
    scoped.push({
      diff: scopedDiff,
      newPath: deltaDiff.newPath,
      oldPath: deltaDiff.oldPath,
    });
  }
  return scoped;
}

export { scopeDeltaDiffsToMrHunks };
