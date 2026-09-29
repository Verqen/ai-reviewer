import { fingerprintFinding } from "~/domain/finding-fingerprint";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding, Severity } from "~/domain/types/review.types";

interface CommitReviewFinding {
  condition: string;
  filePath: string;
  fingerprint: string;
  line: number;
  message: string;
  ruleId: RuleId;
  severity: Severity;
}

interface DroppedCommitReviewFinding {
  filePath: string;
  line: number;
  ruleId: string;
}

function lineKey(filePath: string, line: number): string {
  return `${filePath}\n${String(line)}`;
}

function indexLineTexts(
  diffs: readonly ParsedFileDiff[],
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const diff of diffs) {
    for (const line of diff.lines) {
      if (line.newLine !== undefined) {
        texts.set(lineKey(diff.newPath, line.newLine), line.content);
      }
    }
  }
  return texts;
}

function toCommitReviewFindings(
  findings: readonly Finding[],
  repoId: number,
  lineTexts: ReadonlyMap<string, string>,
): { dropped: DroppedCommitReviewFinding[]; findings: CommitReviewFinding[] } {
  const reported: CommitReviewFinding[] = [];
  const dropped: DroppedCommitReviewFinding[] = [];
  for (const finding of findings) {
    const rule = findCatalogRule(finding.ruleId);
    const lineText = lineTexts.get(
      lineKey(finding.filePath, finding.lineNumber),
    );
    if (rule === undefined || lineText === undefined) {
      dropped.push({
        filePath: finding.filePath,
        line: finding.lineNumber,
        ruleId: finding.ruleId,
      });
      continue;
    }
    reported.push({
      condition: rule.condition,
      filePath: finding.filePath,
      fingerprint: fingerprintFinding(repoId, rule.id, lineText),
      line: finding.lineNumber,
      message: rule.finding,
      ruleId: rule.id,
      severity: finding.severity,
    });
  }
  return { dropped, findings: reported };
}

export { indexLineTexts, toCommitReviewFindings };
export type { CommitReviewFinding, DroppedCommitReviewFinding };
