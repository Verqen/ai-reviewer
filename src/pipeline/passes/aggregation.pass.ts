import type { FastifyBaseLogger } from "fastify";

import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { DismissedPattern } from "~/domain/ports/dismissed-pattern.repository.port";
import type {
  AggregationResult,
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding, Severity } from "~/domain/types/review.types";
import { matchFilePathGlob } from "~/glob/match-file-path-glob";
import { escalateVibeCodingSeverity } from "~/pipeline/prompts/vibe-coding-patterns";
import { findingsMatch, type MatchableFinding } from "~/review/finding-match";

const SEVERITY_ORDER: Record<Severity, number> = {
  attention: 3,
  critical: 4,
  info: 1,
  nitpick: 0,
  warning: 2,
};

function isFindingDuplicate(
  left: MatchableFinding,
  right: MatchableFinding,
  tolerance: number,
): boolean {
  return findingsMatch(left, right, tolerance);
}

function normalizeFindingKey(f: Finding): string {
  const normalized = f.comment.toLowerCase().replace(/\s+/g, " ").trim();
  return `${f.filePath}:${f.lineNumber}:${f.lineType}:${normalized}`;
}

function dedup(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();

  for (const f of findings) {
    const lineKey = `${f.filePath}:${f.lineNumber}:${f.lineType}`;
    const exactKey = normalizeFindingKey(f);

    if (seen.has(exactKey)) {
      continue;
    }

    const existingOnLine = [...seen.values()].find(
      (existing) =>
        `${existing.filePath}:${existing.lineNumber}:${existing.lineType}` ===
        lineKey,
    );

    if (existingOnLine) {
      if (
        SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[existingOnLine.severity]
      ) {
        const existingKey = normalizeFindingKey(existingOnLine);
        seen.delete(existingKey);
        seen.set(exactKey, f);
      }
    } else {
      seen.set(exactKey, f);
    }
  }

  return [...seen.values()];
}

function matchesDismissedPattern(
  finding: Finding,
  pattern: DismissedPattern,
): boolean {
  if (finding.category !== pattern.category) {
    return false;
  }

  if (
    pattern.filePathGlob &&
    !matchFilePathGlob(finding.filePath, pattern.filePathGlob)
  ) {
    return false;
  }

  if (pattern.sampleComment) {
    const normalizedComment = finding.comment.toLowerCase();
    const normalizedPattern = pattern.sampleComment.toLowerCase();
    const keywords = normalizedPattern.split(/\s+/).slice(0, 3);
    return keywords.every((kw) => normalizedComment.includes(kw));
  }

  return true;
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDiff =
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severityDiff !== 0) return severityDiff;
    const pathDiff = a.filePath.localeCompare(b.filePath);
    if (pathDiff !== 0) return pathDiff;
    return a.lineNumber - b.lineNumber;
  });
}

function isSeverityAtOrAbove(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

function capFindings(
  findings: Finding[],
  maxPerFile: number,
  maxPerReview: number,
): Finding[] {
  const perFileCount = new Map<string, number>();
  const capped: Finding[] = [];
  for (const finding of findings) {
    if (capped.length >= maxPerReview) break;
    const used = perFileCount.get(finding.filePath) ?? 0;
    if (used >= maxPerFile) continue;
    perFileCount.set(finding.filePath, used + 1);
    capped.push(finding);
  }
  return capped;
}

function consolidationSignature(finding: Finding): string {
  const normalized = finding.comment
    .toLowerCase()
    .replace(/`[^`]*`/g, "")
    .replace(/[0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${finding.filePath}::${finding.category}::${normalized}`;
}

function consolidateRecurringFindings(
  findings: Finding[],
  minOccurrences: number,
): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = consolidationSignature(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  const result: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length < minOccurrences) {
      result.push(...group);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        b.confidence - a.confidence,
    );
    const representative = sorted[0];
    if (representative === undefined) {
      result.push(...group);
      continue;
    }
    const otherLines = sorted
      .slice(1)
      .map((finding) => finding.lineNumber)
      .join(", ");
    result.push({
      ...representative,
      comment: `${representative.comment}\n\nThis pattern recurs at ${String(group.length)} locations in this file (also lines ${otherLines}); address them together.`,
    });
  }
  return result;
}

class AggregationPass implements IReviewPass<AggregationResult> {
  readonly name = "aggregation";

  constructor(
    private readonly dismissedPatternRepo: IDismissedPatternRepository,
    private readonly logger: FastifyBaseLogger,
    private readonly lineShiftDedupTolerance: number,
  ) {}

  async execute(
    context: ReviewContext,
    priorResults: Map<string, PassResult>,
  ): Promise<PassResult<AggregationResult>> {
    const {
      forcePushCorrelation,
      priorFindingsByFile,
      projectId,
      reviewConfig,
    } = context;

    const fileReviewFindings = priorResults.get("file-review")?.findings ?? [];
    const crossFileFindings = priorResults.get("cross-file")?.findings ?? [];

    this.logger.info(
      {
        crossFileFindingsCount: crossFileFindings.length,
        fileReviewFindingsCount: fileReviewFindings.length,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
      },
      "Aggregation pass starting",
    );

    const combined = consolidateRecurringFindings(
      escalateVibeCodingSeverity(
        dedup([...fileReviewFindings, ...crossFileFindings]),
      ),
      reviewConfig.consolidateMinOccurrences,
    );

    const dedupedCount = combined.length;

    const dismissedPatterns =
      await this.dismissedPatternRepo.findByProject(projectId);

    const dismissedPatternCount = dismissedPatterns.length;

    const occurrenceThreshold =
      reviewConfig.learning?.minOccurrencesToSuppress ?? 3;

    let suppressedCount = 0;
    const allFindings: Finding[] = [];

    for (const finding of combined) {
      const isDismissed = dismissedPatterns.some(
        (p) =>
          p.occurrenceCount >= occurrenceThreshold &&
          matchesDismissedPattern(finding, p),
      );

      if (isDismissed) {
        suppressedCount++;
      } else {
        allFindings.push(finding);
      }
    }

    const threshold = reviewConfig.severityThreshold;
    const repostedFindings =
      forcePushCorrelation?.correlated.map((item) => ({
        ...item.finding,
        lineNumber: item.newLineNumber,
      })) ?? [];
    const repostedByFile = new Map<string, Finding[]>();
    for (const reposted of repostedFindings) {
      const list = repostedByFile.get(reposted.filePath) ?? [];
      list.push(reposted);
      repostedByFile.set(reposted.filePath, list);
    }
    const lineShiftTolerance = this.lineShiftDedupTolerance;
    const postableFindings = allFindings.filter((f) => {
      if (!isSeverityAtOrAbove(f.severity, threshold)) {
        return false;
      }
      if (f.confidence < reviewConfig.inlineMinConfidence) {
        return false;
      }

      const priorPending = priorFindingsByFile?.pending.get(f.filePath) ?? [];
      if (
        priorPending.some((existing) =>
          isFindingDuplicate(existing, f, lineShiftTolerance),
        )
      ) {
        return false;
      }
      const reposted = repostedByFile.get(f.filePath) ?? [];
      return !reposted.some((existing) =>
        isFindingDuplicate(existing, f, lineShiftTolerance),
      );
    });

    const sortedAll = sortFindings(allFindings);
    const sortedPostable = capFindings(
      sortFindings(postableFindings),
      reviewConfig.maxFindingsPerFile,
      reviewConfig.maxFindingsPerReview,
    );

    this.logger.info(
      {
        allFindingsCount: sortedAll.length,
        crossFileFindingsCount: crossFileFindings.length,
        dedupedCount,
        dismissedPatternCount,
        fileReviewFindingsCount: fileReviewFindings.length,
        mrIid: context.mrIid,
        postableFindingsCount: sortedPostable.length,
        projectId: context.projectId,
        repostedFindingsCount: repostedFindings.length,
        reviewRunId: context.reviewRunId,
        severityThreshold: threshold,
        suppressedCount,
      },
      "Aggregation completed",
    );

    const aggregationResult: AggregationResult = {
      allFindings: sortedAll,
      postableFindings: sortedPostable,
      repostedFindings,
      suppressedCount,
    };

    return {
      findings: sortedPostable,
      metadata: aggregationResult,
      tokenUsage: { completionTokens: 0, promptTokens: 0 },
    };
  }
}

export { AggregationPass };
