import { compareFindings } from "~/domain/finding-comparison";
import type { CommitReviewFinding } from "~/review/commit-review-finding";

const RESOLVED_LIST_LIMIT = 100;
const SHORT_SHA_LENGTH = 7;
const DATE_LENGTH = 10;

const FIRST_RUN_SUMMARY =
  "First run for this repository: there is no earlier result to compare with.";

interface CommitReviewBaseline {
  catalogVersion: string;
  commitSha: string;
  findings: readonly {
    filePath: string;
    fingerprint: string;
    line: number;
    ruleId: string;
  }[];
  finishedAt: string;
  runId: string;
}

interface ResolvedCommitFinding {
  fileRemoved: boolean;
  filePath: string;
  line: number;
  ruleId: string;
}

interface CommitReviewComparison {
  baselineCatalogVersion: string;
  baselineCommitSha: string;
  baselineFinishedAt: string;
  baselineRunId: string;
  new: number;
  notComparable: number;
  persisting: number;
  resolved: ResolvedCommitFinding[];
}

type ComparisonLabel = "new" | "persisting";

interface CommitRunComparison {
  comparison: CommitReviewComparison;
  labels: ReadonlyMap<CommitReviewFinding, ComparisonLabel>;
}

interface CatalogChange {
  comparableRuleCount: number;
  currentVersion: string;
  notComparableRuleCount: number;
}

function compareCommitRun(params: {
  baseline: CommitReviewBaseline;
  comparableRuleIds: ReadonlySet<string>;
  currentPaths: ReadonlySet<string>;
  findings: readonly CommitReviewFinding[];
  unreviewedPaths: ReadonlySet<string>;
}): CommitRunComparison {
  const result = compareFindings({
    baseline: params.baseline.findings,
    comparableRuleIds: params.comparableRuleIds,
    current: params.findings,
    currentPaths: params.currentPaths,
    unreviewedPaths: params.unreviewedPaths,
  });
  const fresh = new Set(result.new);
  const persisting = new Set(result.persisting.map((pair) => pair.current));
  const labels = new Map<CommitReviewFinding, ComparisonLabel>();
  for (const finding of params.findings) {
    if (fresh.has(finding)) labels.set(finding, "new");
    if (persisting.has(finding)) labels.set(finding, "persisting");
  }
  return {
    comparison: {
      baselineCatalogVersion: params.baseline.catalogVersion,
      baselineCommitSha: params.baseline.commitSha,
      baselineFinishedAt: params.baseline.finishedAt,
      baselineRunId: params.baseline.runId,
      new: result.new.length,
      notComparable: result.notComparable,
      persisting: result.persisting.length,
      resolved: result.resolved.map(({ fileRemoved, finding }) => ({
        fileRemoved,
        filePath: finding.filePath,
        line: finding.line,
        ruleId: finding.ruleId,
      })),
    },
    labels,
  };
}

function describeResolved(finding: ResolvedCommitFinding): string {
  const removed = finding.fileRemoved ? " (file removed)" : "";
  return `- ${finding.ruleId} · ${finding.filePath}:${String(finding.line)}${removed}`;
}

function buildComparisonSummary(
  comparison: CommitReviewComparison,
  catalog: CatalogChange,
): string {
  const heading = `**Comparison with run ${comparison.baselineCommitSha.slice(0, SHORT_SHA_LENGTH)} (${comparison.baselineFinishedAt.slice(0, DATE_LENGTH)})**`;
  const counts = `New: ${String(comparison.new)} · Persisting: ${String(comparison.persisting)} · Resolved: ${String(comparison.resolved.length)}`;
  const catalogLine =
    comparison.baselineCatalogVersion === catalog.currentVersion
      ? ""
      : `Rule catalog changed ${comparison.baselineCatalogVersion} → ${catalog.currentVersion}: ${String(catalog.comparableRuleCount)} rules compared, ${String(catalog.notComparableRuleCount)} not comparable.`;
  const listed = comparison.resolved
    .slice(0, RESOLVED_LIST_LIMIT)
    .map(describeResolved)
    .join("\n");
  const hidden = comparison.resolved.length - RESOLVED_LIST_LIMIT;
  const more = hidden > 0 ? `and ${String(hidden)} more` : "";
  return [heading, counts, catalogLine, listed, more]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export { buildComparisonSummary, compareCommitRun, FIRST_RUN_SUMMARY };
export type {
  CatalogChange,
  CommitReviewBaseline,
  CommitReviewComparison,
  CommitRunComparison,
  ComparisonLabel,
};
