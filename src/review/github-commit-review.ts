import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import { GitHubConfig } from "~/config/github.config";
import {
  assertCostCeilingEnforceable,
  computeReviewRunCostUsd,
} from "~/config/llm-pricing";
import { CostBudget } from "~/domain/cost-budget";
import {
  RULE_CATALOG_VERSION,
  findCatalogRule,
} from "~/domain/rule-catalog/rule-catalog";
import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import type { ILlmClient } from "~/domain/ports/llm.port";
import { ResolvedReviewPipelineConfigSchema } from "~/domain/types/config.types";
import type {
  AggregationResult,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding, Severity } from "~/domain/types/review.types";
import type {
  CheckRunAnnotation,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import {
  createGitHubOctokit,
  GitHubCodeHost as GitHubCodeHostAdapter,
} from "~/infrastructure/code-host/github/github.code-host";
import { createSilentLogger } from "~/infrastructure/logging/silent-logger";
import type { ReviewModels } from "~/review/review-pass-run";
import {
  buildOverlay,
  createReviewLlm,
  runReviewPasses,
} from "~/review/review-pass-run";
import {
  assertReviewableFileLimit,
  RepositoryTooLargeError,
} from "~/review/repository-size";
import { buildWholeFileDiffs } from "~/review/whole-file-diff";

const CHECK_RUN_NAME = "Verqen";

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
  logger?: FastifyBaseLogger;
}

interface CommitReviewFinding {
  ruleId: RuleId;
  severity: Severity;
  condition: string;
  filePath: string;
  line: number;
}

interface GitHubCommitReviewResult {
  checkRunUrl: string;
  filesReviewed: number;
  filesTotal: number;
  partial: boolean;
  findings: CommitReviewFinding[];
  catalogVersion: string;
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
}

const FileReviewCoverageSchema = z.object({
  pathsSkippedCostCeiling: z.array(z.string()).default([]),
});

function pathsSkippedForCost(
  passResults: ReadonlyMap<string, PassResult>,
): ReadonlySet<string> {
  const coverage = FileReviewCoverageSchema.parse(
    passResults.get("file-review")?.metadata ?? {},
  );
  return new Set(coverage.pathsSkippedCostCeiling);
}

function publishedFindings(
  passResults: ReadonlyMap<string, PassResult>,
): Finding[] {
  const aggregation = passResults.get("aggregation")?.metadata as
    | Partial<AggregationResult>
    | undefined;
  return aggregation?.postableFindings ?? [];
}

function toCommitReviewFinding(finding: Finding): CommitReviewFinding {
  return {
    condition: finding.comment,
    filePath: finding.filePath,
    line: finding.lineNumber,
    ruleId: finding.ruleId,
    severity: finding.severity,
  };
}

function toAnnotation(
  finding: CommitReviewFinding,
  catalogUrl: string | undefined,
): CheckRunAnnotation {
  const rule = findCatalogRule(finding.ruleId);
  const details = [
    rule === undefined ? "" : `Condition: ${rule.condition}`,
    catalogUrl === undefined ? "" : `Rule: ${catalogUrl}#${finding.ruleId}`,
  ].filter((part) => part.length > 0);
  return {
    line: finding.line,
    message: finding.condition,
    path: finding.filePath,
    ...(details.length > 0 ? { rawDetails: details.join("\n") } : {}),
    severity: finding.severity,
    title: `${finding.ruleId} · ${rule?.title ?? finding.ruleId}`,
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
  filesReviewed: number;
  filesTotal: number;
  findingCount: number;
  partial: boolean;
}): string {
  const scope = `Reviewed ${String(params.filesReviewed)} of ${String(params.filesTotal)} files at commit ${params.commitSha}.`;
  const partialNote = params.partial
    ? "> **Partial result.** The cost ceiling for this run was reached before every file was reviewed. Files that were not reviewed carry no findings."
    : "";
  const catalog = `Rule catalog ${params.catalogVersion}. Each finding is a match of a published rule; the check makes no code changes.`;
  const findings = `${buildCheckRunTitle(params.findingCount)}; each one is attached to its file and line below.`;
  const cleanup =
    "The run is complete. Please uninstall the GitHub App from your account or organisation now: it keeps read access to the repositories you selected until you remove it.";
  return [scope, partialNote, catalog, findings, cleanup]
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

type TreeReview = Omit<GitHubCommitReviewResult, "checkRunUrl">;

async function reviewTree(
  dependencies: CommitReviewDependencies,
  options: GitHubCommitReviewOptions,
  projectId: number,
  prepared: WholeFileDiffs,
): Promise<TreeReview> {
  const { codeHost, llm, logger, models } = dependencies;
  const { commitSha } = options;
  const { diffs, reviewablePaths } = prepared;

  const costBudget = new CostBudget(options.maxCostUsd);
  const context: ReviewContext = {
    costBudget,
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

  const { partial, passResults } = await runReviewPasses({
    context,
    costBudget,
    llm,
    logger,
  });

  const skipped = pathsSkippedForCost(passResults);
  return {
    catalogVersion: RULE_CATALOG_VERSION,
    filesReviewed: reviewablePaths.filter((path) => !skipped.has(path)).length,
    filesTotal: reviewablePaths.length,
    findings: publishedFindings(passResults).map(toCommitReviewFinding),
    partial,
    tokenCostUsd: computeReviewRunCostUsd(passResults, models),
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

  const projectId = await codeHost.getRepoId(options.owner, options.repo);
  const archive = await codeHost.getRepositoryArchive(projectId, commitSha);
  const prepared = buildWholeFileDiffs(archive);
  if (prepared.reviewablePaths.length > options.maxReviewableFiles) {
    throw new RepositoryTooLargeError(
      prepared.reviewablePaths.length,
      options.maxReviewableFiles,
    );
  }
  const checkRun = await codeHost.createCheckRun(projectId, {
    headSha: commitSha,
    name: CHECK_RUN_NAME,
  });

  try {
    const review = await reviewTree(dependencies, options, projectId, prepared);
    await codeHost.updateCheckRun(projectId, checkRun.id, {
      annotations: review.findings.map((finding) =>
        toAnnotation(finding, options.catalogUrl),
      ),
      conclusion: "neutral",
      summary: buildCheckRunSummary({
        catalogVersion: review.catalogVersion,
        commitSha,
        filesReviewed: review.filesReviewed,
        filesTotal: review.filesTotal,
        findingCount: review.findings.length,
        partial: review.partial,
      }),
      title: buildCheckRunTitle(review.findings.length),
    });
    return { ...review, checkRunUrl: checkRun.url };
  } catch (error) {
    await closeCheckRunAsCancelled(dependencies, projectId, checkRun.id);
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

async function reviewGitHubCommit(
  options: GitHubCommitReviewOptions,
): Promise<GitHubCommitReviewResult> {
  const logger = options.logger ?? createSilentLogger();
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHostAdapter(octokit, githubConfig, logger);
  const { llm, models } = createReviewLlm(logger, options.maxCostUsd);
  return reviewRepositoryCommit({ codeHost, llm, logger, models }, options);
}

export {
  countGitHubReviewableFiles,
  countRepositoryReviewableFiles,
  resolveDefaultBranchHead,
  resolveGitHubDefaultBranchHead,
  reviewGitHubCommit,
  reviewRepositoryCommit,
};
export type {
  CommitReviewCodeHost,
  CommitReviewFinding,
  GitHubDefaultBranchHead,
  GitHubCommitReviewOptions,
  GitHubCommitReviewResult,
};
