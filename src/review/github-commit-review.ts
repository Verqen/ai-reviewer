import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import { GitHubConfig } from "~/config/github.config";
import {
  assertCostCeilingEnforceable,
  computeReviewRunCostUsd,
} from "~/config/llm-pricing";
import { CostBudget } from "~/domain/cost-budget";
import { selectConsensusFindings } from "~/domain/finding-consensus";
import {
  RULE_CATALOG_VERSION,
  catalogComparability,
  findCatalogRule,
} from "~/domain/rule-catalog/rule-catalog";
import type { ILlmClient } from "~/domain/ports/llm.port";
import { ResolvedReviewPipelineConfigSchema } from "~/domain/types/config.types";
import type {
  AggregationResult,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
import type {
  CheckRunAnnotation,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import {
  createGitHubOctokit,
  GitHubCodeHost as GitHubCodeHostAdapter,
} from "~/infrastructure/code-host/github/github.code-host";
import { createSilentLogger } from "~/infrastructure/logging/silent-logger";
import type {
  CommitReviewBaseline,
  CommitReviewComparison,
  ComparisonLabel,
} from "~/review/commit-review-comparison";
import {
  buildComparisonSummary,
  compareCommitRun,
  FIRST_RUN_SUMMARY,
} from "~/review/commit-review-comparison";
import type { CommitReviewFinding } from "~/review/commit-review-finding";
import {
  indexLineTexts,
  toCommitReviewFindings,
} from "~/review/commit-review-finding";
import type { ReviewModels, ReviewPassRun } from "~/review/review-pass-run";
import {
  buildOverlay,
  createReviewLlm,
  runReviewPasses,
} from "~/review/review-pass-run";
import {
  assertReviewableFileLimit,
  RepositoryTooLargeError,
} from "~/review/repository-size";
import type { ProviderPins } from "~/review/reproducible-llm";
import { createReproducibleLlm } from "~/review/reproducible-llm";
import { buildWholeFileDiffs } from "~/review/whole-file-diff";

const CHECK_RUN_NAME = "Verqen";
const CONSENSUS_PASSES = 3;
const CONSENSUS_QUORUM = 2;

type CommitReviewCodeHost = Pick<
  GitHubCodeHost,
  | "createCheckRun"
  | "getFileContent"
  | "getFileTree"
  | "getRepoId"
  | "getRepositoryArchive"
  | "updateCheckRun"
>;

interface GitHubCommitReviewOptions {
  owner: string;
  repo: string;
  installationId?: number | undefined;
  commitSha: string;
  maxCostUsd: number;
  maxReviewableFiles: number;
  catalogUrl?: string | undefined;
  baseline?: CommitReviewBaseline | undefined;
  models?: ReviewModels | undefined;
  logger?: FastifyBaseLogger;
}

interface GitHubCommitReviewResult {
  checkRunUrl: string;
  filesReviewed: number;
  filesTotal: number;
  partial: boolean;
  findings: CommitReviewFinding[];
  catalogVersion: string;
  comparison: CommitReviewComparison | null;
  tokenCostUsd: number;
}

interface GitHubDefaultBranchHead {
  repoId: number;
  defaultBranch: string;
  headSha: string;
}

type DefaultBranchCodeHost = Pick<
  GitHubCodeHost,
  "getBranchHeadSha" | "getDefaultBranch" | "getRepoId"
>;

interface CommitReviewDependencies {
  codeHost: CommitReviewCodeHost;
  llm: ILlmClient;
  logger: FastifyBaseLogger;
  models: ReviewModels;
  providerPins: ProviderPins | null;
}

const FileReviewCoverageSchema = z.object({
  pathsFailed: z.array(z.string()).default([]),
  pathsSkippedCostCeiling: z.array(z.string()).default([]),
});

function pathsNotFullyReviewed(passResults: ReadonlyMap<string, PassResult>): {
  failed: string[];
  skipped: string[];
} {
  const coverage = FileReviewCoverageSchema.parse(
    passResults.get("file-review")?.metadata ?? {},
  );
  return {
    failed: coverage.pathsFailed,
    skipped: coverage.pathsSkippedCostCeiling,
  };
}

function publishedFindings(
  passResults: ReadonlyMap<string, PassResult>,
): Finding[] {
  const aggregation = passResults.get("aggregation")?.metadata as
    | Partial<AggregationResult>
    | undefined;
  return aggregation?.postableFindings ?? [];
}

function toAnnotation(
  finding: CommitReviewFinding,
  catalogUrl: string | undefined,
  label: ComparisonLabel | undefined,
): CheckRunAnnotation {
  const details = [
    `Condition: ${finding.condition}`,
    catalogUrl === undefined ? "" : `Rule: ${catalogUrl}#${finding.ruleId}`,
  ].filter((part) => part.length > 0);
  return {
    line: finding.line,
    message: finding.message,
    path: finding.filePath,
    rawDetails: details.join("\n"),
    severity: finding.severity,
    title: `${finding.ruleId} · ${findCatalogRule(finding.ruleId)?.title ?? finding.ruleId}${label === undefined ? "" : ` · ${label}`}`,
  };
}

function buildCheckRunTitle(findingCount: number): string {
  return findingCount === 0
    ? "No findings"
    : `${String(findingCount)} finding(s)`;
}

function buildCheckRunSummary(params: {
  catalogVersion: string;
  commitSha: string;
  comparisonSummary: string;
  filesReviewed: number;
  filesTotal: number;
  findingCount: number;
  partial: boolean;
}): string {
  const scope = `Reviewed ${String(params.filesReviewed)} of ${String(params.filesTotal)} files at commit ${params.commitSha}.`;
  const partialNote = params.partial
    ? "> **Partial result.** Not every file was fully reviewed: the cost ceiling for this run was reached or the review of a file failed. Files that were not fully reviewed may carry no findings."
    : "";
  const catalog = `Rule catalog ${params.catalogVersion}. Each finding is a match of a published rule; the check makes no code changes.`;
  const consensus = `Each finding was detected in at least ${String(CONSENSUS_QUORUM)} of ${String(CONSENSUS_PASSES)} independent passes over the same code.`;
  const findings =
    params.findingCount === 0
      ? `No rule of the catalog matched. Checked ${String(params.filesReviewed)} of ${String(params.filesTotal)} files.`
      : `${buildCheckRunTitle(params.findingCount)}; each one is attached to its file and line below.`;
  const cleanup =
    "The run is complete. Please uninstall the GitHub App from your account or organisation now: it keeps read access to the repositories you selected until you remove it.";
  return [
    scope,
    partialNote,
    catalog,
    consensus,
    findings,
    params.comparisonSummary,
    cleanup,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function resolveDefaultBranchHead(
  codeHost: DefaultBranchCodeHost,
  repository: { owner: string; repo: string },
): Promise<GitHubDefaultBranchHead> {
  const repoId = await codeHost.getRepoId(repository.owner, repository.repo);
  const defaultBranch = await codeHost.getDefaultBranch(repoId);
  const headSha = await codeHost.getBranchHeadSha(repoId, defaultBranch);
  return { defaultBranch, headSha, repoId };
}

async function resolveGitHubDefaultBranchHead(options: {
  owner: string;
  repo: string;
  installationId?: number | undefined;
  logger?: FastifyBaseLogger;
}): Promise<GitHubDefaultBranchHead> {
  const logger = options.logger ?? createSilentLogger();
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHostAdapter(octokit, githubConfig, logger);
  return resolveDefaultBranchHead(codeHost, options);
}

type WholeFileDiffs = ReturnType<typeof buildWholeFileDiffs>;

type TreeReview = Omit<GitHubCommitReviewResult, "checkRunUrl" | "comparison">;

async function reviewTree(
  dependencies: CommitReviewDependencies,
  options: GitHubCommitReviewOptions,
  projectId: number,
  prepared: WholeFileDiffs,
  archivePaths: readonly string[],
): Promise<{ review: TreeReview; unreviewedPaths: ReadonlySet<string> }> {
  const { codeHost, llm, logger, models } = dependencies;
  const { commitSha } = options;
  const { diffs, reviewablePaths } = prepared;

  const context: Omit<ReviewContext, "costBudget"> = {
    diffs,
    isIncremental: false,
    mrIid: 0,
    mrInfo: {
      description: "",
      iid: 0,
      projectId,
      sourceBranch: commitSha,
      targetBranch: commitSha,
      title: `Repository check @ ${commitSha}`,
    },
    overlayView: buildOverlay(codeHost, projectId, commitSha),
    previousFindings: [],
    projectId,
    reviewConfig: ResolvedReviewPipelineConfigSchema.parse({
      severityThreshold: "info",
      modelOverrides: { review: true, triage: true },
      models: { premium: null, review: models.review, triage: models.triage },
      pathRules: [],
    }),
    reviewRunId: "github-commit-review",
    toolCallCache: new Map(),
    versions: { baseSha: commitSha, headSha: commitSha, startSha: commitSha },
  };

  const runs: ReviewPassRun[] = [];
  for (let pass = 0; pass < CONSENSUS_PASSES; pass++) {
    const costBudget = new CostBudget(options.maxCostUsd / CONSENSUS_PASSES);
    runs.push(
      await runReviewPasses({
        context: { ...context, costBudget },
        costBudget,
        llm,
        logger,
      }),
    );
  }

  const lineTexts = indexLineTexts(prepared.diffs);
  const coverage = runs.map((passRun) =>
    pathsNotFullyReviewed(passRun.passResults),
  );
  const reviewable = new Set(reviewablePaths);
  const unreviewedPaths = new Set([
    ...coverage.flatMap((paths) => [...paths.skipped, ...paths.failed]),
    ...archivePaths.filter((path) => !reviewable.has(path)),
  ]);
  const findingsByPass = runs.map((passRun) => {
    const reported = toCommitReviewFindings(
      publishedFindings(passRun.passResults),
      projectId,
      lineTexts,
    );
    for (const dropped of reported.dropped) {
      logger.warn(
        dropped,
        "Dropped a commit-review finding whose rule or anchored line is missing",
      );
    }
    return reported.findings;
  });
  return {
    review: {
      catalogVersion: RULE_CATALOG_VERSION,
      filesReviewed: reviewablePaths.filter(
        (path) => !unreviewedPaths.has(path),
      ).length,
      filesTotal: reviewablePaths.length,
      findings: selectConsensusFindings(findingsByPass, CONSENSUS_QUORUM),
      partial:
        runs.some((passRun) => passRun.partial) ||
        coverage.some((paths) => paths.failed.length > 0),
      tokenCostUsd: runs.reduce(
        (total, passRun) =>
          total + computeReviewRunCostUsd(passRun.passResults, models),
        0,
      ),
    },
    unreviewedPaths,
  };
}

async function closeCheckRunAsCancelled(
  dependencies: CommitReviewDependencies,
  projectId: number,
  checkRunId: number,
): Promise<void> {
  try {
    await dependencies.codeHost.updateCheckRun(projectId, checkRunId, {
      annotations: [],
      conclusion: "cancelled",
      summary:
        "The check stopped before it finished and published no findings. It will be run again.",
      title: "Check did not complete",
    });
  } catch (error) {
    dependencies.logger.warn(
      { checkRunId, error, projectId },
      "Failed to close the check run after a failed commit review",
    );
  }
}

async function reviewRepositoryCommit(
  dependencies: CommitReviewDependencies,
  options: GitHubCommitReviewOptions,
): Promise<GitHubCommitReviewResult> {
  const { codeHost } = dependencies;
  const { commitSha } = options;
  assertCostCeilingEnforceable(dependencies.models, options.maxCostUsd);
  assertReviewableFileLimit(options.maxReviewableFiles);
  const reproducible: CommitReviewDependencies = {
    ...dependencies,
    llm: createReproducibleLlm(
      dependencies.llm,
      dependencies.models,
      dependencies.providerPins,
    ),
  };

  const baseline = options.baseline;
  const catalog =
    baseline === undefined
      ? null
      : catalogComparability(baseline.catalogVersion);

  const projectId = await codeHost.getRepoId(options.owner, options.repo);
  const archive = await codeHost.getRepositoryArchive(projectId, commitSha);
  const prepared = buildWholeFileDiffs(archive);
  const archivePaths = archive.map((entry) => entry.path);
  if (prepared.reviewablePaths.length > options.maxReviewableFiles) {
    throw new RepositoryTooLargeError(
      prepared.reviewablePaths.length,
      options.maxReviewableFiles,
    );
  }
  const checkRun = await codeHost.createCheckRun(projectId, {
    detailsUrl: options.catalogUrl,
    headSha: commitSha,
    name: CHECK_RUN_NAME,
  });

  try {
    const { review, unreviewedPaths } = await reviewTree(
      reproducible,
      options,
      projectId,
      prepared,
      archivePaths,
    );
    const compared =
      baseline === undefined || catalog === null
        ? null
        : compareCommitRun({
            baseline,
            comparableRuleIds: catalog.comparableRuleIds,
            currentPaths: new Set(archivePaths),
            findings: review.findings,
            unreviewedPaths,
          });
    const comparisonSummary =
      compared === null || catalog === null
        ? FIRST_RUN_SUMMARY
        : buildComparisonSummary(compared.comparison, {
            comparableRuleCount: catalog.comparableRuleIds.size,
            currentVersion: review.catalogVersion,
            notComparableRuleCount: catalog.notComparableRuleCount,
          });
    await codeHost.updateCheckRun(projectId, checkRun.id, {
      annotations: review.findings.map((finding) =>
        toAnnotation(
          finding,
          options.catalogUrl,
          compared?.labels.get(finding),
        ),
      ),
      conclusion: "neutral",
      summary: buildCheckRunSummary({
        catalogVersion: review.catalogVersion,
        commitSha,
        comparisonSummary,
        filesReviewed: review.filesReviewed,
        filesTotal: review.filesTotal,
        findingCount: review.findings.length,
        partial: review.partial,
      }),
      title: buildCheckRunTitle(review.findings.length),
    });
    return {
      ...review,
      checkRunUrl: checkRun.url,
      comparison: compared?.comparison ?? null,
    };
  } catch (error) {
    await closeCheckRunAsCancelled(reproducible, projectId, checkRun.id);
    throw error;
  }
}

async function countRepositoryReviewableFiles(
  codeHost: Pick<CommitReviewCodeHost, "getRepoId" | "getRepositoryArchive">,
  options: { commitSha: string; owner: string; repo: string },
): Promise<{ reviewableFiles: number }> {
  const projectId = await codeHost.getRepoId(options.owner, options.repo);
  const archive = await codeHost.getRepositoryArchive(
    projectId,
    options.commitSha,
  );
  return {
    reviewableFiles: buildWholeFileDiffs(archive).reviewablePaths.length,
  };
}

async function countGitHubReviewableFiles(options: {
  commitSha: string;
  installationId?: number | undefined;
  logger?: FastifyBaseLogger;
  owner: string;
  repo: string;
}): Promise<{ reviewableFiles: number }> {
  const logger = options.logger ?? createSilentLogger();
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHostAdapter(octokit, githubConfig, logger);
  return countRepositoryReviewableFiles(codeHost, options);
}

function resolveOrderModels(
  envModels: ReviewModels,
  orderModels: ReviewModels | undefined,
): ReviewModels {
  return orderModels ?? envModels;
}

async function reviewGitHubCommit(
  options: GitHubCommitReviewOptions,
): Promise<GitHubCommitReviewResult> {
  const logger = options.logger ?? createSilentLogger();
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHostAdapter(octokit, githubConfig, logger);
  const reviewLlm = createReviewLlm(
    logger,
    options.models === undefined ? options.maxCostUsd : undefined,
  );
  return reviewRepositoryCommit(
    {
      codeHost,
      llm: reviewLlm.llm,
      logger,
      models: resolveOrderModels(reviewLlm.models, options.models),
      providerPins: reviewLlm.providerPins,
    },
    options,
  );
}

export {
  countGitHubReviewableFiles,
  countRepositoryReviewableFiles,
  resolveDefaultBranchHead,
  resolveGitHubDefaultBranchHead,
  resolveOrderModels,
  reviewGitHubCommit,
  reviewRepositoryCommit,
};
export type {
  CommitReviewBaseline,
  CommitReviewCodeHost,
  CommitReviewComparison,
  CommitReviewFinding,
  GitHubDefaultBranchHead,
  GitHubCommitReviewOptions,
  GitHubCommitReviewResult,
};
