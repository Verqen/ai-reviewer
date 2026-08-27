import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SCANNED_DIRECTORIES = ["src", "scripts"] as const;
const IGNORED_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "logs",
]);
const MAX_REPORTED_TEXT_LENGTH = 120;

interface CommentViolation {
  filePath: string;
  line: number;
  text: string;
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(join(REPOSITORY_ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (filePath) =>
        !relative(REPOSITORY_ROOT, filePath)
          .split(sep)
          .some((segment) => IGNORED_PATH_SEGMENTS.has(segment)),
    )
    .sort();
}

function firstLineOf(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > MAX_REPORTED_TEXT_LENGTH
    ? `${line.slice(0, MAX_REPORTED_TEXT_LENGTH)}...`
    : line;
}

function collectCommentViolations(filePath: string): CommentViolation[] {
  const text = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations: CommentViolation[] = [];
  const reportedPositions = new Set<number>();

  const visit = (node: ts.Node): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of ranges) {
      if (reportedPositions.has(range.pos)) {
        continue;
      }
      reportedPositions.add(range.pos);
      violations.push({
        filePath: relative(REPOSITORY_ROOT, filePath),
        line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1,
        text: firstLineOf(text.slice(range.pos, range.end)),
      });
    }
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };

  visit(sourceFile);
  return violations.sort((left, right) => left.line - right.line);
}

function formatViolation(violation: CommentViolation): string {
  return `${violation.filePath}:${violation.line}: ${violation.text}`;
}

describe("no comments in code", () => {
  const scannedFiles = SCANNED_DIRECTORIES.flatMap(listTypeScriptFiles);

  it("scans every TypeScript file under src and scripts", () => {
    expect(scannedFiles.length).toBeGreaterThan(0);
    for (const directory of SCANNED_DIRECTORIES) {
      expect(
        scannedFiles.some((filePath) =>
          filePath.startsWith(join(REPOSITORY_ROOT, directory)),
        ),
      ).toBe(true);
    }
  });

  it("finds no line, block or doc comment in any scanned file", () => {
    const violations = scannedFiles
      .flatMap(collectCommentViolations)
      .map(formatViolation);
    expect(violations).toEqual([]);
  });
});
