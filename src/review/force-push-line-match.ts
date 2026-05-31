import type {
  ForcePushCorrelationCandidate,
  ForcePushLineCorrelationPlan,
  ForcePushLineMatchOptions,
} from "~/domain/types/force-push-correlation.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { DiffLine, ParsedFileDiff } from "~/review/diff-parser";

function expandTabStopsToSpaces(content: string, tabWidth: number): string {
  let column = 0;
  let result = "";
  for (const char of content) {
    if (char === "\t") {
      const spaces = tabWidth - (column % tabWidth);
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += char;
      column = char === "\n" ? 0 : column + 1;
    }
  }
  return result;
}

function normalizeLineContent(
  content: string,
  lineMatchTabWidth: number,
): string {
  const expanded = expandTabStopsToSpaces(content, lineMatchTabWidth);
  const leadingMatch = /^(\s*)/.exec(expanded);
  const leading = leadingMatch?.[1] ?? "";
  const rest = expanded.slice(leading.length).trimEnd().replace(/\s+/g, " ");
  return leading + rest;
}

interface DiffLineIndex {
  byContent: Map<string, DiffLine[]>;
  diff: ParsedFileDiff;
}

function buildDiffLineIndex(
  diff: ParsedFileDiff,
  lineMatchTabWidth: number,
): DiffLineIndex {
  const byContent = new Map<string, DiffLine[]>();
  for (const line of diff.lines) {
    const key = normalizeLineContent(line.content, lineMatchTabWidth);
    const bucket = byContent.get(key);
    if (bucket) {
      bucket.push(line);
    } else {
      byContent.set(key, [line]);
    }
  }
  return { byContent, diff };
}

function isLineInWindow(
  line: DiffLine,
  windowMin: number,
  windowMax: number,
): boolean {
  if (
    line.newLine !== undefined &&
    line.newLine >= windowMin &&
    line.newLine <= windowMax
  ) {
    return true;
  }
  return (
    line.oldLine !== undefined &&
    line.oldLine >= windowMin &&
    line.oldLine <= windowMax
  );
}

function resolveLineNumber(line: DiffLine): number | null {
  return line.newLine ?? line.oldLine ?? null;
}

function findCorrelatedLine(
  lineExcerpt: string,
  oldLineNumber: number,
  hunkHeader: string | undefined,
  index: DiffLineIndex,
  lineWindow: number,
  lineMatchTabWidth: number,
): number | null {
  const normalized = normalizeLineContent(lineExcerpt, lineMatchTabWidth);
  const candidates = index.byContent.get(normalized);
  const fallback = candidates?.[0];
  if (!candidates || !fallback) {
    return null;
  }
  const windowMin = oldLineNumber - lineWindow;
  const windowMax = oldLineNumber + lineWindow;
  for (const candidate of candidates) {
    if (isLineInWindow(candidate, windowMin, windowMax)) {
      return resolveLineNumber(candidate);
    }
  }
  if (hunkHeader) {
    for (const candidate of candidates) {
      if (candidate.hunkHeader === hunkHeader) {
        return resolveLineNumber(candidate);
      }
    }
  }
  return resolveLineNumber(fallback);
}

function planForcePushLineCorrelation(
  previousFindings: ReviewFinding[],
  newDiffs: ParsedFileDiff[],
  options: ForcePushLineMatchOptions,
): ForcePushLineCorrelationPlan {
  const { lineMatchTabWidth, lineWindow } = options;
  const diffsByPath = new Map(newDiffs.map((d) => [d.newPath, d]));
  const indexByDiff = new WeakMap<ParsedFileDiff, DiffLineIndex>();
  const correlated: ForcePushCorrelationCandidate[] = [];
  const findingsToMarkAddressed: ReviewFinding[] = [];
  const pendingFindingIds: string[] = [];
  for (const finding of previousFindings) {
    if (!finding.hostDiscussionId) {
      pendingFindingIds.push(finding.id);
      continue;
    }
    const diff = diffsByPath.get(finding.filePath);
    if (!diff) {
      findingsToMarkAddressed.push(finding);
      continue;
    }
    if (!finding.lineExcerpt) {
      pendingFindingIds.push(finding.id);
      continue;
    }
    let index = indexByDiff.get(diff);
    if (!index) {
      index = buildDiffLineIndex(diff, lineMatchTabWidth);
      indexByDiff.set(diff, index);
    }
    const newLineNumber = findCorrelatedLine(
      finding.lineExcerpt,
      finding.lineNumber,
      finding.hunkHeader,
      index,
      lineWindow,
      lineMatchTabWidth,
    );
    if (newLineNumber !== null) {
      correlated.push({ finding, newLineNumber });
    } else {
      findingsToMarkAddressed.push(finding);
    }
  }
  return { correlated, findingsToMarkAddressed, pendingFindingIds };
}

export { planForcePushLineCorrelation };
