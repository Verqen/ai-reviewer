import type {
  InlinePosition,
  VersionInfo,
} from "~/domain/types/code-host.types";
import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding } from "~/domain/types/review.types";

interface InlinePositionResult {
  position: InlinePosition;
  snappedFromLine?: number;
}

function findExactMatch(
  finding: Finding,
  fileDiff: ParsedFileDiff,
): DiffLine | null {
  const match = fileDiff.lines.find((line) => {
    if (finding.lineType === "removed") {
      return line.type === "removed" && line.oldLine === finding.lineNumber;
    }
    return (
      (line.type === "added" || line.type === "context") &&
      line.newLine === finding.lineNumber
    );
  });
  return match ?? null;
}

function makePosition(
  finding: Finding,
  versions: VersionInfo,
  fileDiff: ParsedFileDiff,
  matchingLine: DiffLine,
): InlinePosition | null {
  const position: InlinePosition = {
    baseSha: versions.baseSha,
    headSha: versions.headSha,
    newPath: finding.filePath,
    oldPath: finding.oldPath ?? fileDiff.oldPath,
    positionType: "text",
    startSha: versions.startSha,
  };
  if (matchingLine.type === "added" && matchingLine.newLine !== undefined) {
    position.newLine = matchingLine.newLine;
    return position;
  }
  if (matchingLine.type === "removed" && matchingLine.oldLine !== undefined) {
    position.oldLine = matchingLine.oldLine;
    return position;
  }
  if (
    matchingLine.newLine !== undefined &&
    matchingLine.oldLine !== undefined
  ) {
    position.newLine = matchingLine.newLine;
    position.oldLine = matchingLine.oldLine;
    return position;
  }
  return null;
}

function buildPosition(
  finding: Finding,
  versions: VersionInfo,
  diffs: ParsedFileDiff[],
): InlinePositionResult | null {
  const fileDiff = diffs.find((d) => d.newPath === finding.filePath);
  if (!fileDiff) {
    return null;
  }
  const exact = findExactMatch(finding, fileDiff);
  if (exact) {
    const position = makePosition(finding, versions, fileDiff, exact);
    return position ? { position } : null;
  }
  return null;
}

function originalSnippetMatchesDiff(
  originalSnippet: string,
  finding: Finding,
  diffs: ParsedFileDiff[],
): boolean {
  const fileDiff = diffs.find((d) => d.newPath === finding.filePath);
  if (!fileDiff) {
    return false;
  }
  const endLine = finding.endLineNumber ?? finding.lineNumber;
  const relevantLines = fileDiff.lines.filter((line) => {
    const lineNum =
      finding.lineType === "removed" ? line.oldLine : line.newLine;
    return (
      lineNum !== undefined &&
      lineNum >= finding.lineNumber &&
      lineNum <= endLine
    );
  });
  const diffSnippet = relevantLines.map((l) => l.content).join("\n");
  const normalizedDiff = diffSnippet.replace(/\r\n/g, "\n").trim();
  const normalizedSnippet = originalSnippet.replace(/\r\n/g, "\n").trim();
  return (
    normalizedDiff === normalizedSnippet ||
    normalizedDiff.includes(normalizedSnippet)
  );
}

export { buildPosition, originalSnippetMatchesDiff };
export type { InlinePositionResult };
