import type { ArchiveEntry } from "~/domain/types/code-host.types";
import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";
import {
  DEFAULT_MAX_DIFF_CHARACTERS,
  DEFAULT_MAX_DIFF_LINES,
} from "~/review/diff-parser";

const MAX_REVIEWABLE_FILE_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const NUL_BYTE = 0;

interface WholeFileDiffs {
  diffs: ParsedFileDiff[];
  reviewablePaths: string[];
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(NUL_BYTE);
}

function isReviewable(entry: ArchiveEntry): boolean {
  return (
    entry.content.length > 0 &&
    entry.content.length <= MAX_REVIEWABLE_FILE_BYTES &&
    getPrimarySkipReason(entry.path) === null &&
    !looksBinary(entry.content)
  );
}

function splitLines(content: Buffer): string[] {
  const lines = content.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function promptHeaderLength(path: string): number {
  return `--- ${path}\n+++ ${path}`.length + 1;
}

function renderedLineLength(lineNumber: number, content: string): number {
  return `L${String(lineNumber)} + ${content}`.length + 1;
}

function splitIntoRanges(
  path: string,
  lines: readonly string[],
): { count: number; start: number }[] {
  const ranges: { count: number; start: number }[] = [];
  let start = 1;
  let count = 0;
  let characters = promptHeaderLength(path);
  for (const [index, content] of lines.entries()) {
    const lineNumber = index + 1;
    const length = renderedLineLength(lineNumber, content);
    const overflows =
      count >= DEFAULT_MAX_DIFF_LINES ||
      characters + length > DEFAULT_MAX_DIFF_CHARACTERS;
    if (count > 0 && overflows) {
      ranges.push({ count, start });
      start = lineNumber;
      count = 0;
      characters = promptHeaderLength(path);
    }
    count++;
    characters += length;
  }
  if (count > 0) {
    ranges.push({ count, start });
  }
  return ranges;
}

function toAddedHunk(
  path: string,
  lines: readonly string[],
  range: { count: number; start: number },
): ParsedFileDiff {
  const hunkHeader = `@@ -0,0 +${String(range.start)},${String(range.count)} @@`;
  const hunkLines: DiffLine[] = lines
    .slice(range.start - 1, range.start - 1 + range.count)
    .map((content, offset) => ({
      content,
      hunkHeader,
      newLine: range.start + offset,
      type: "added",
    }));
  return { lines: hunkLines, newPath: path, oldPath: path };
}

function buildWholeFileDiffs(entries: readonly ArchiveEntry[]): WholeFileDiffs {
  const diffs: ParsedFileDiff[] = [];
  const reviewablePaths: string[] = [];
  for (const entry of entries) {
    if (!isReviewable(entry)) continue;
    const lines = splitLines(entry.content);
    if (lines.length === 0) continue;
    reviewablePaths.push(entry.path);
    for (const range of splitIntoRanges(entry.path, lines)) {
      diffs.push(toAddedHunk(entry.path, lines, range));
    }
  }
  return { diffs, reviewablePaths };
}

export { buildWholeFileDiffs };
export type { WholeFileDiffs };
