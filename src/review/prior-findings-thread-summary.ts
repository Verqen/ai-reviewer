import type { PriorFindings, ReviewFinding } from "~/domain/types/review.types";

const COMMENT_PREVIEW_LENGTH = 80;
const MAX_FINDINGS_PER_FILE = 3;

function filterOutFinding(
  findings: readonly ReviewFinding[],
  excludeId: string
): ReviewFinding[] {
  return findings.filter((f) => f.id !== excludeId);
}

function formatFindingGroup(
  label: string,
  findings: readonly ReviewFinding[]
): string | undefined {
  if (findings.length === 0) {
    return undefined;
  }
  const byFile = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const existing = byFile.get(f.filePath) ?? [];
    existing.push(f);
    byFile.set(f.filePath, existing);
  }
  const blocks: string[] = [`${label}`];
  for (const [filePath, fileFindings] of [...byFile.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const summaries = fileFindings
      .slice(0, MAX_FINDINGS_PER_FILE)
      .map(
        (f) =>
          `  [${f.severity}/${f.category}] L${String(f.lineNumber)}: ${f.comment.slice(0, COMMENT_PREVIEW_LENGTH)}`
      )
      .join("\n");
    blocks.push(`${filePath}:\n${summaries}`);
  }
  return blocks.join("\n\n");
}

function buildThreadPriorFindingsSummary(
  prior: PriorFindings,
  excludeFindingId: string,
  maxChars: number
): string | undefined {
  const pending = filterOutFinding(prior.pending, excludeFindingId);
  const addressed = filterOutFinding(prior.addressed, excludeFindingId);
  const dismissed = filterOutFinding(prior.dismissed, excludeFindingId);
  const parts = [
    "Other findings on this MR (summary):",
    formatFindingGroup("Pending:", pending),
    formatFindingGroup("Addressed:", addressed),
    formatFindingGroup("Dismissed / wont_fix:", dismissed),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (parts.length <= 1) {
    return undefined;
  }
  const assembled = parts.join("\n\n");
  if (assembled.length <= maxChars) {
    return assembled;
  }
  return `${assembled.slice(0, maxChars)}\n...(prior findings truncated)`;
}

export { buildThreadPriorFindingsSummary };
