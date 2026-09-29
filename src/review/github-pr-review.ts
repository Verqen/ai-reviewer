import type { FastifyBaseLogger } from "fastify";

import { GitHubConfig } from "~/config/github.config";
import { computeReviewRunCostUsd } from "~/config/llm-pricing";
import { readRuntimeEnv } from "~/config/runtime.env";
import { ResolvedReviewPipelineConfigSchema } from "~/domain/types/config.types";
import type {
  AggregationResult,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type {
  Finding,
  LineType,
  PriorFindingsByFile,
  ReviewFinding,
  Severity,
} from "~/domain/types/review.types";
import {
  createGitHubOctokit,
  createGitHubOctokitFromToken,
  GitHubCodeHost,
  listInstallationRepositories,
} from "~/infrastructure/code-host/github/github.code-host";
import { createSilentLogger } from "~/infrastructure/logging/silent-logger";
import { CostBudget } from "~/domain/cost-budget";
import { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";
import { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
import { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";
import { parseDiff } from "~/review/diff-parser";
import { findingsMatch } from "~/review/finding-match";
import { buildPosition } from "~/review/finding-inline-position";
import { computeProductionReadinessScore } from "~/review/scoring.service";
import {
  buildOverlay,
  createReviewLlm,
  runReviewPasses,
} from "~/review/review-pass-run";
import type { Grade } from "~/review/scoring.service";

export type GitHubReviewPostMode = "inline" | "summary";

export interface PriorThreadRef {
  filePath: string;
  line: number;
  lineType: LineType;
  category: string;
  severity: Severity;
  hostDiscussionId: string;
}

export interface ReviewPathRule {
  path: string;
  extraRules?: string | undefined;
  focus?: string[] | undefined;
}

export interface GitHubPullRequestReviewOptions {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  post?: boolean;
  postMode?: GitHubReviewPostMode | undefined;
  installationId?: number | undefined;
  previousThreads?: PriorThreadRef[] | undefined;
  maxCostUsd?: number | undefined;
  sinceSha?: string | undefined;
  resolverToken?: string | undefined;
  pathRules?: ReviewPathRule[] | undefined;
  showCostFooter?: boolean | undefined;
  logger?: FastifyBaseLogger;
}

export interface ReviewedFinding {
  severity: Severity;
  category: string;
  filePath: string;
  line: number;
  lineType: LineType;
  comment: string;
  suggestion: string | null;
  anchored: boolean;
  hostDiscussionId: string | null;
  hostNoteId: string | null;
}

export interface GitHubPullRequestReviewResult {
  repoId: number;
  score: number;
  grade: Grade;
  findings: ReviewedFinding[];
  postedCount: number;
  partial: boolean;
  incremental: boolean;
  resolvedThreadIds: string[];
  tokenCostUsd: number;
}

function defaultLogger(provided?: FastifyBaseLogger): FastifyBaseLogger {
  return provided ?? createSilentLogger();
}

function locationKey(path: string, line: number): string {
  return `${path}:${String(line)}`;
}

const SUMMARY_MARKER = "<!-- verqen-review:summary -->";

const PRIOR_THREAD_LINE_TOLERANCE = 3;

function priorThreadToReviewFinding(thread: PriorThreadRef): ReviewFinding {
  return {
    category: thread.category,
    comment: "",
    confidence: 1,
    filePath: thread.filePath,
    hostDiscussionId: thread.hostDiscussionId,
    id: thread.hostDiscussionId,
    lineNumber: thread.line,
    lineType: thread.lineType,
    model: "",
    passName: "prior",
    resolution: "pending",
    reviewRunId: "prior",
    severity: thread.severity,
  };
}

function buildPriorFindingsByFile(
  threads: readonly PriorThreadRef[],
): PriorFindingsByFile {
  const pending = new Map<string, ReviewFinding[]>();
  for (const thread of threads) {
    const list = pending.get(thread.filePath) ?? [];
    list.push(priorThreadToReviewFinding(thread));
    pending.set(thread.filePath, list);
  }
  return { addressed: new Map(), dismissed: new Map(), pending };
}

function aggregateTokenUsageByModel(
  passResults: ReadonlyMap<string, PassResult>,
  models: { review: string; triage: string },
): Record<string, { completionTokens: number; promptTokens: number }> {
  const totals: Record<
    string,
    { completionTokens: number; promptTokens: number }
  > = {};
  for (const [passName, result] of passResults) {
    const byModel = result.tokenUsageByModel ?? {
      [passName === "triage" ? models.triage : models.review]:
        result.tokenUsage,
    };
    for (const [model, usage] of Object.entries(byModel)) {
      const bucket = totals[model] ?? { completionTokens: 0, promptTokens: 0 };
      bucket.completionTokens += usage.completionTokens;
      bucket.promptTokens += usage.promptTokens;
      totals[model] = bucket;
    }
  }
  return totals;
}

export interface GitHubPullRequestHead {
  repoId: number;
  headSha: string;
}

export async function resolveGitHubPullRequestHead(options: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  installationId?: number | undefined;
  logger?: FastifyBaseLogger;
}): Promise<GitHubPullRequestHead> {
  const { owner, repo, pullRequestNumber } = options;
  const logger = defaultLogger(options.logger);
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHost(octokit, githubConfig, logger);
  const repoId = await codeHost.getRepoId(owner, repo);
  const versions = await codeHost.getMergeRequestVersions(
    repoId,
    pullRequestNumber,
  );
  return { headSha: versions.headSha, repoId };
}

export interface InstallationRepository {
  id: number;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export async function listGitHubInstallationRepositories(options: {
  installationId: number;
}): Promise<InstallationRepository[]> {
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const repositories = await listInstallationRepositories(octokit);
  return repositories.map((repository) => ({
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    id: repository.id,
    isPrivate: repository.isPrivate,
  }));
}

export async function reviewGitHubPullRequest(
  options: GitHubPullRequestReviewOptions,
): Promise<GitHubPullRequestReviewResult> {
  const { owner, repo, pullRequestNumber, post = false } = options;
  const previousThreads = options.previousThreads ?? [];
  const logger = defaultLogger(options.logger);

  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHost(octokit, githubConfig, logger);

  const projectId = await codeHost.getRepoId(owner, repo);

  const mrInfo = await codeHost.getMergeRequestInfo(
    projectId,
    pullRequestNumber,
  );
  const versions = await codeHost.getMergeRequestVersions(
    projectId,
    pullRequestNumber,
  );
  const incremental =
    options.sinceSha !== undefined &&
    options.sinceSha !== "" &&
    options.sinceSha !== versions.headSha;
  const diffFiles = incremental
    ? await codeHost.getCommitRangeDiff(
        projectId,
        options.sinceSha ?? "",
        versions.headSha,
      )
    : await codeHost.getMergeRequestDiff(projectId, pullRequestNumber);

  const reviewable = diffFiles.filter(
    (file) => getPrimarySkipReason(file.newPath) === null,
  );
  const parsedDiffs = reviewable.map(parseDiff);
  const reviewedFilePaths = new Set(reviewable.map((file) => file.newPath));

  const { llm, models } = createReviewLlm(logger, options.maxCostUsd);

  const costBudget = new CostBudget(options.maxCostUsd);

  const context: ReviewContext = {
    costBudget,
    diffs: parsedDiffs,
    isIncremental: incremental,
    mrIid: pullRequestNumber,
    mrInfo: {
      description: mrInfo.description,
      iid: pullRequestNumber,
      projectId,
      sourceBranch: mrInfo.sourceBranch,
      targetBranch: mrInfo.targetBranch,
      title: mrInfo.title,
    },
    overlayView: buildOverlay(codeHost, projectId, versions.headSha),
    previousFindings: [],
    priorFindingsByFile:
      previousThreads.length > 0
        ? buildPriorFindingsByFile(previousThreads)
        : undefined,
    projectId,
    reviewConfig: ResolvedReviewPipelineConfigSchema.parse({
      severityThreshold: "info",
      modelOverrides: { review: true, triage: true },
      models: { premium: null, review: models.review, triage: models.triage },
      pathRules: options.pathRules ?? [],
    }),
    reviewRunId: "github-pr-review",
    toolCallCache: new Map(),
    versions,
  };

  const { partial, passResults } = await runReviewPasses({
    context,
    costBudget,
    llm,
    logger,
  });

  const aggMeta = passResults.get("aggregation")?.metadata as
    | Partial<AggregationResult>
    | undefined;
  const allFindings: Finding[] = aggMeta?.allFindings ?? [];
  const postable: Finding[] = aggMeta?.postableFindings ?? [];
  const suppressedCount = aggMeta?.suppressedCount ?? 0;
  const carriedForScore = incremental
    ? previousThreads
        .filter((thread) => !reviewedFilePaths.has(thread.filePath))
        .map((thread) => ({
          category: thread.category,
          severity: thread.severity,
        }))
    : [];
  const score = computeProductionReadinessScore([
    ...allFindings,
    ...carriedForScore,
  ]);

  const postableSet = new Set(postable);
  const postedThreadByFinding = new Map<
    Finding,
    { discussionId: string; noteId: string }
  >();

  const tokenCostUsd = computeReviewRunCostUsd(passResults, models);
  const tokenUsageByModel = aggregateTokenUsageByModel(passResults, models);

  const useContentDedup = previousThreads.length > 0;

  let postedCount = 0;
  if (post) {
    const postMode = options.postMode ?? "inline";
    if (postMode === "inline") {
      const ownLocations = await codeHost.listOwnReviewCommentLocations(
        projectId,
        pullRequestNumber,
      );
      const alreadyPosted = new Set(
        ownLocations.map((location) =>
          locationKey(location.path, location.line),
        ),
      );
      for (const finding of postable) {
        const positionResult = buildPosition(finding, versions, parsedDiffs);
        if (!positionResult) continue;
        const targetLine =
          positionResult.position.newLine ?? finding.lineNumber;
        if (alreadyPosted.has(locationKey(finding.filePath, targetLine))) {
          continue;
        }
        const body = formatCommentWithSuggestion(
          finding.comment,
          finding.severity,
          finding.suggestion,
          finding.originalSnippet,
          finding.lineType,
          positionResult.position.newLine ?? finding.lineNumber,
          finding.endLineNumber,
        );
        try {
          const posted = await codeHost.postInlineComment(
            projectId,
            pullRequestNumber,
            body,
            positionResult.position,
          );
          postedThreadByFinding.set(finding, posted);
          postedCount++;
        } catch (error) {
          logger.warn(
            { error, filePath: finding.filePath, line: targetLine },
            "Failed to post inline comment; skipping (best-effort)",
          );
        }
      }
    }

    const partialNote = partial
      ? "\n\n> **Large change — partial review.** The per-scan cost ceiling was reached, so file-level findings are reported but cross-file analysis was skipped. Upgrade for full coverage."
      : "";
    const incrementalNote = incremental
      ? `\n\n> _Incremental review: only the ${String(reviewedFilePaths.size)} file(s) changed since the last review were re-analyzed; prior findings on unchanged files still stand._`
      : "";
    const overview =
      allFindings.length === 0
        ? incremental
          ? "No new issues in the changed files."
          : "No issues found."
        : `${String(allFindings.length)} finding(s); ${String(postedCount)} posted inline.`;
    const showCostFooter =
      options.showCostFooter ?? readRuntimeEnv().SHOW_REVIEW_COST_FOOTER;
    const summaryBody = `## AI Review — production-readiness: ${String(score.score)}/100 (grade ${score.grade})${partialNote}${incrementalNote}\n\n${buildSummaryNote(
      {
        allFindings,
        includeCostFooter: showCostFooter,
        overview,
        postableFindings: postable,
        suppressedCount,
        tokenCostUsd,
        tokenUsageByModel,
      },
    )}`;
    const summaryNote = `${summaryBody}\n\n${SUMMARY_MARKER}`;
    await codeHost.upsertNote(
      projectId,
      pullRequestNumber,
      summaryNote,
      SUMMARY_MARKER,
    );
  }

  const resolvedThreadIds: string[] = [];
  if (post && useContentDedup && !partial) {
    const resolverCodeHost =
      options.resolverToken !== undefined && options.resolverToken !== ""
        ? new GitHubCodeHost(
            createGitHubOctokitFromToken(githubConfig, options.resolverToken),
            githubConfig,
            logger,
          )
        : codeHost;
    for (const thread of previousThreads) {
      if (!reviewedFilePaths.has(thread.filePath)) continue;
      const stillPresent = allFindings.some((finding) =>
        findingsMatch(
          {
            category: finding.category,
            filePath: finding.filePath,
            lineNumber: finding.lineNumber,
            lineType: finding.lineType,
          },
          {
            category: thread.category,
            filePath: thread.filePath,
            lineNumber: thread.line,
            lineType: thread.lineType,
          },
          PRIOR_THREAD_LINE_TOLERANCE,
        ),
      );
      if (stillPresent) continue;
      try {
        await resolverCodeHost.resolveDiscussion(
          projectId,
          pullRequestNumber,
          thread.hostDiscussionId,
        );
        resolvedThreadIds.push(thread.hostDiscussionId);
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            hostDiscussionId: thread.hostDiscussionId,
            mrIid: pullRequestNumber,
            projectId,
          },
          "Failed to auto-resolve thread (continuing; review is unaffected)",
        );
      }
    }
  }

  const findings: ReviewedFinding[] = allFindings.map((finding) => {
    const posted = postedThreadByFinding.get(finding) ?? null;
    return {
      severity: finding.severity,
      category: finding.category,
      filePath: finding.filePath,
      line: finding.lineNumber,
      lineType: finding.lineType,
      comment: finding.comment,
      suggestion: finding.suggestion ?? null,
      anchored: postableSet.has(finding),
      hostDiscussionId: posted?.discussionId ?? null,
      hostNoteId: posted?.noteId ?? null,
    };
  });

  return {
    repoId: projectId,
    score: score.score,
    grade: score.grade,
    findings,
    postedCount,
    partial,
    incremental,
    resolvedThreadIds,
    tokenCostUsd,
  };
}
