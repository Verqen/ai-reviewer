import type { DiffFile } from "~/domain/types/code-host.types";
import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DEFAULT_MAX_DIFF_LINES = 600;
const DEFAULT_MAX_DIFF_CHARACTERS = 24_000;
const DEFAULT_CONTEXT_RADIUS = 2;
const DEFAULT_ANCHOR_CATALOG_GROUP_BY_HUNK_THRESHOLD = 24;

function parseDiff(file: DiffFile): ParsedFileDiff {
  const lines: DiffLine[] = [];
  const rawLines = file.diff.split("\n");

  let oldLine = 0;
  let newLine = 0;
  let currentHunkHeader = "";

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;

    if (raw === "" && i === rawLines.length - 1) {
      break;
    }

    if (raw.startsWith("\\ ")) {
      continue;
    }

    const hunkMatch = HUNK_HEADER_REGEX.exec(raw);

    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      currentHunkHeader = raw;
      continue;
    }

    if (oldLine === 0 && newLine === 0) {
      continue;
    }

    if (raw.startsWith("+")) {
      lines.push({
        content: raw.slice(1),
        hunkHeader: currentHunkHeader,
        newLine,
        type: "added",
      });
      newLine++;
    } else if (raw.startsWith("-")) {
      lines.push({
        content: raw.slice(1),
        hunkHeader: currentHunkHeader,
        oldLine,
        type: "removed",
      });
      oldLine++;
    } else if (raw.startsWith(" ")) {
      lines.push({
        content: raw.slice(1),
        hunkHeader: currentHunkHeader,
        newLine,
        oldLine,
        type: "context",
      });
      oldLine++;
      newLine++;
    }
  }

  return {
    lines,
    newPath: file.newPath,
    oldPath: file.oldPath,
  };
}

function formatParsedDiffForPrompt(parsed: ParsedFileDiff): string {
  const header = `--- ${parsed.oldPath}\n+++ ${parsed.newPath}`;

  const body = parsed.lines
    .map((line) => {
      const prefix =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      const lineNum =
        line.type === "removed" ? `L${line.oldLine}` : `L${line.newLine}`;

      return `${lineNum} ${prefix} ${line.content}`;
    })
    .join("\n");

  return `${header}\n${body}`;
}

function getAnchorCatalogLineNumber(line: DiffLine): number {
  if (line.type === "removed") {
    return line.oldLine ?? 0;
  }
  return line.newLine ?? 0;
}

type FormatAllowableAnchorsOptions = {
  groupByHunkAboveLineCount?: number | undefined;
};

function formatAllowableAnchorsForPrompt(
  lines: readonly DiffLine[],
  options?: FormatAllowableAnchorsOptions
): string {
  const threshold =
    options?.groupByHunkAboveLineCount ??
    DEFAULT_ANCHOR_CATALOG_GROUP_BY_HUNK_THRESHOLD;
  if (lines.length === 0) {
    return "No diff lines included in this prompt section.";
  }
  const rowForLine = (line: DiffLine): string => {
    const n = getAnchorCatalogLineNumber(line);
    return `| ${line.type} | ${String(n)} |`;
  };
  const tableHeader = "| line_type | line_number |\n| --- | --- |";
  if (lines.length <= threshold) {
    const body = lines.map(rowForLine).join("\n");
    return `${tableHeader}\n${body}`;
  }
  const hunkOrder: string[] = [];
  const seenHunk = new Set<string>();
  for (const line of lines) {
    const key = line.hunkHeader;
    if (!seenHunk.has(key)) {
      seenHunk.add(key);
      hunkOrder.push(key);
    }
  }
  const byHunk = new Map<string, DiffLine[]>();
  for (const line of lines) {
    const list = byHunk.get(line.hunkHeader) ?? [];
    list.push(line);
    byHunk.set(line.hunkHeader, list);
  }
  const sections: string[] = [];
  for (let i = 0; i < hunkOrder.length; i++) {
    const headerKey = hunkOrder[i]!;
    const hLines = byHunk.get(headerKey) ?? [];
    const label = `H${String(i)}`;
    const ref = headerKey.trim().length > 0 ? ` (\`${headerKey.trim()}\`)` : "";
    const body = hLines.map(rowForLine).join("\n");
    sections.push(`### ${label}${ref}\n\n${tableHeader}\n${body}`);
  }
  return sections.join("\n\n");
}

type DiffPromptBudgetOptions = {
  contextRadius?: number | undefined;
  maxCharacters?: number | undefined;
  maxLines?: number | undefined;
};

type DiffPromptPayload = {
  allowableAnchorsText: string;
  isTruncated: boolean;
  text: string;
};

function formatParsedDiffForPromptWithBudget(
  parsed: ParsedFileDiff,
  options?: DiffPromptBudgetOptions
): DiffPromptPayload {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const maxCharacters = options?.maxCharacters ?? DEFAULT_MAX_DIFF_CHARACTERS;
  const contextRadius = options?.contextRadius ?? DEFAULT_CONTEXT_RADIUS;
  const changedLineIndexes = parsed.lines
    .map((line, index) => ({ index, line }))
    .filter((entry) => entry.line.type !== "context")
    .map((entry) => entry.index);
  const includedIndexes = new Set<number>();
  for (const lineIndex of changedLineIndexes) {
    const from = Math.max(0, lineIndex - contextRadius);
    const to = Math.min(parsed.lines.length - 1, lineIndex + contextRadius);
    for (let idx = from; idx <= to; idx++) {
      includedIndexes.add(idx);
    }
  }
  const selectedLines =
    changedLineIndexes.length === 0
      ? parsed.lines.slice(0, maxLines)
      : parsed.lines.filter((_, index) => includedIndexes.has(index));
  const header = `--- ${parsed.oldPath}\n+++ ${parsed.newPath}`;
  const bodyLines: string[] = [];
  const includedDiffLinesForPrompt: DiffLine[] = [];
  let totalCharacters = header.length + 1;
  for (const line of selectedLines) {
    if (bodyLines.length >= maxLines) {
      break;
    }
    const prefix =
      line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
    const lineNum =
      line.type === "removed" ? `L${line.oldLine}` : `L${line.newLine}`;
    const rendered = `${lineNum} ${prefix} ${line.content}`;
    if (totalCharacters + rendered.length + 1 > maxCharacters) {
      break;
    }
    bodyLines.push(rendered);
    includedDiffLinesForPrompt.push(line);
    totalCharacters += rendered.length + 1;
  }
  const isTruncated =
    bodyLines.length < selectedLines.length ||
    selectedLines.length < parsed.lines.length;
  const suffix = isTruncated
    ? `\n... diff truncated: included ${bodyLines.length}/${parsed.lines.length} lines`
    : "";
  const allowableAnchorsText = formatAllowableAnchorsForPrompt(
    includedDiffLinesForPrompt
  );
  return {
    allowableAnchorsText,
    isTruncated,
    text: `${header}\n${bodyLines.join("\n")}${suffix}`,
  };
}

export { formatParsedDiffForPrompt, parseDiff };
export {
  DEFAULT_ANCHOR_CATALOG_GROUP_BY_HUNK_THRESHOLD,
  formatAllowableAnchorsForPrompt,
  getAnchorCatalogLineNumber,
  formatParsedDiffForPromptWithBudget,
};
export type {
  FormatAllowableAnchorsOptions,
  DiffPromptBudgetOptions,
  DiffPromptPayload,
};
export type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
