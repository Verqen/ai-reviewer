import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

import { GitHubConfig } from "~/config/github.config";
import {
  assertCostCeilingEnforceable,
  computeReviewRunCostUsd,
} from "~/config/llm-pricing";
import { CostBudget } from "~/domain/cost-budget";
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
import type { ReviewPathRule } from "~/review/github-pr-review";
import type { ReviewModels } from "~/review/review-pass-run";
import {
  buildOverlay,
  createReviewLlm,
  runReviewPasses,
} from "~/review/review-pass-run";
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
  pathRules?: ReviewPathRule[] | undefined;
  logger?: FastifyBaseLogger;
}

interface CommitReviewFinding {
  rule: string;
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

const CODE_FENCE = "```";

function publishedFindings(
  passResults: ReadonlyMap<string, PassResult>,
  logger: FastifyBaseLogger,
): Finding[] {
  const aggregation = passResults.get("aggregation")?.metadata as
    | Partial<AggregationResult>
    | undefined;
  return (aggregation?.postableFindings ?? []).filter((finding) => {
    if (!finding.comment.includes(CODE_FENCE)) return true;
    logger.warn(
      {
        filePath: finding.filePath,
        lineNumber: finding.lineNumber,
        passName: finding.passName,
      },
      "Dropping commit-review finding with code in comment",
    );
    return false;
  });
}

function toCommitReviewFinding(finding: Finding): CommitReviewFinding {
  return {
    condition: finding.comment,
    filePath: finding.filePath,
    line: finding.lineNumber,
    rule: finding.category,
    severity: finding.severity,
  };
}

function toAnnotation(finding: CommitReviewFinding): CheckRunAnnotation {
  return {
    line: finding.line,
    message: finding.condition,
    path: finding.filePath,
    severity: finding.severity,
    title: finding.rule,
  };
}

function buildCheckRunTitle(findingCount: number): string {
  return findingCount === 0
    ? "No findings"
    : `${String(findingCount)} finding(s)`;
}

function buildCheckRunSummary(params: {
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
  const findings = `${buildCheckRunTitle(params.findingCount)}; each one is attached to its file and line below.`;
  const cleanup =
    "The run is complete. Please uninstall the GitHub App from your account or organisation now: it keeps read access to the repositories you selected until you remove it.";
  return [scope, partialNote, findings, cleanup]
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

type TreeReview = Omit<GitHubCommitReviewResult, "checkRunUrl">;

async function reviewTree(
  dependencies: CommitReviewDependencies,
  options: GitHubCommitReviewOptions,
  projectId: number,
): Promise<TreeReview> {
  const { codeHost, llm, logger, models } = dependencies;
  const { commitSha } = options;

  const archive = await codeHost.getRepositoryArchive(projectId, commitSha);
  const { diffs, reviewablePaths } = buildWholeFileDiffs(archive);

  const costBudget = new CostBudget(options.maxCostUsd);
  const context: ReviewContext = {
    costBudget,
    diffs,
    findingSuggestions: "omitted",
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
      pathRules: options.pathRules ?? [],
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
    filesReviewed: reviewablePaths.filter((path) => !skipped.has(path)).length,
    filesTotal: reviewablePaths.length,
    findings: publishedFindings(passResults, logger).map(toCommitReviewFinding),
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

  const projectId = await codeHost.getRepoId(options.owner, options.repo);
  const checkRun = await codeHost.createCheckRun(projectId, {
    headSha: commitSha,
    name: CHECK_RUN_NAME,
  });

  try {
    const review = await reviewTree(dependencies, options, projectId);
    await codeHost.updateCheckRun(projectId, checkRun.id, {
      annotations: review.findings.map(toAnnotation),
      conclusion: "neutral",
      summary: buildCheckRunSummary({
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
