/**
 * Public entry point for reviewing a GitHub pull request end-to-end and getting
 * a STRUCTURED result back (score, grade, findings) — as opposed to the
 * server pipeline, which posts to the code host and returns void.
 *
 * This is the reusable form of the `review-github-pr` script: the SaaS control
 * plane (and any other consumer) calls this instead of re-implementing the
 * pipeline wiring. Posting to the PR is opt-in (`post: true`); by default it is
 * a read-only review.
 *
 * Required env: GitHub App credentials (`GITHUB_APP_*`) and an LLM provider
 * (`OPENROUTER_API_KEY` or Ollama).
 */

import type { Octokit } from "@octokit/rest";
import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";

import { GitHubConfig } from "~/config/github.config";
import { computeReviewRunCostUsd } from "~/config/llm-pricing";
import { LlmConfig } from "~/config/llm.config";
import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import { ResolvedReviewPipelineConfigSchema } from "~/domain/types/config.types";
import type { ToolCall } from "~/domain/types/llm.types";
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
} from "~/infrastructure/code-host/github/github.code-host";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
import { CostBudget } from "~/pipeline/cost-budget";
import { AggregationPass } from "~/pipeline/passes/aggregation.pass";
import { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
import { FileReviewPass } from "~/pipeline/passes/file-review.pass";
import { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";
import {
  applyTriageFilter,
  type TriagePassMetadata,
  TriagePass,
} from "~/pipeline/passes/triage.pass";
import { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
import { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";
import { parseDiff } from "~/review/diff-parser";
import { findingsMatch } from "~/review/finding-match";
import { buildPosition } from "~/review/finding-inline-position";
import { computeProductionReadinessScore } from "~/review/scoring.service";
import type { Grade } from "~/review/scoring.service";

/**
 * How much to post back to the PR when `post` is true. `inline` posts inline
 * threads plus a summary note (the full review); `summary` posts only the
 * summary note, leaving the diff uncluttered.
 */
export type GitHubReviewPostMode = "inline" | "summary";

export interface PriorThreadRef {
  filePath: string;
  line: number;
  lineType: LineType;
  category: string;
  severity: Severity;
  hostDiscussionId: string;
}

export interface GitHubPullRequestReviewOptions {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  /** Post inline threads + a summary note to the PR. Default: false (read-only). */
  post?: boolean;
  /** Posting granularity when `post` is true. Default: `inline`. */
  postMode?: GitHubReviewPostMode | undefined;
  /** App installation to act as; falls back to the env installation when absent. */
  installationId?: number | undefined;
  /**
   * Threads still open from a previous review of this PR. When provided, already
   * reported findings are deduplicated by content (file/lineType/category within
   * tolerance) instead of by scraping the host, and threads whose finding is no
   * longer reproduced on a file changed by this push are auto-resolved.
   */
  previousThreads?: PriorThreadRef[] | undefined;
  /**
   * Per-scan dollar ceiling. Once the live LLM cost crosses it, file review
   * stops taking new files and the cross-file pass is skipped, finalizing an
   * honest partial review. Model-invariant (dollars, not tokens).
   */
  maxCostUsd?: number | undefined;
  /**
   * Head SHA already reviewed by the previous scan of this PR. When set, only
   * files changed since it are reviewed (incremental), prior findings on
   * unchanged files are carried into the score, and auto-resolve is gated to the
   * changed files. Bounds cost on big iterative PRs without re-burning tokens.
   */
  sinceSha?: string | undefined;
  /**
   * A GitHub user OAuth token used ONLY to resolve review threads. GitHub App
   * installation tokens cannot resolve threads (`resolveReviewThread` →
   * "Resource not accessible by integration"); a user token from the installer
   * can. When absent, auto-resolve is attempted with the App token (best-effort,
   * logged) and typically no-ops on GitHub.
   */
  resolverToken?: string | undefined;
  logger?: FastifyBaseLogger;
}

/** A finding in a transport-neutral shape, ready to persist or render. */
export interface ReviewedFinding {
  severity: Severity;
  category: string;
  filePath: string;
  line: number;
  lineType: LineType;
  comment: string;
  suggestion: string | null;
  /** Anchored to an exact diff position (postable inline). */
  anchored: boolean;
  /** Host id of the inline thread opened for this finding this run, if any. */
  hostDiscussionId: string | null;
  /** Host id of the inline note opened for this finding this run, if any. */
  hostNoteId: string | null;
}

export interface GitHubPullRequestReviewResult {
  /** Provider-side repository id. */
  repoId: number;
  score: number;
  grade: Grade;
  findings: ReviewedFinding[];
  /** Inline threads actually posted (0 unless `post` was true). */
  postedCount: number;
  /** True when the per-scan cost ceiling halted the review before full coverage. */
  partial: boolean;
  /** True when only files changed since `sinceSha` were reviewed (delta). */
  incremental: boolean;
  /** Prior threads auto-resolved this run because the finding was fixed. */
  resolvedThreadIds: string[];
  /** Estimated LLM cost of this run, in USD (0 for unpriced/self-hosted models). */
  tokenCostUsd: number;
}

/** No-op recurring-pattern store: a stateless PR review keeps no history. */
const noopDismissedPatternRepo: IDismissedPatternRepository = {
  create: () => Promise.reject(new Error("not supported in stateless review")),
  findByProject: () => Promise.resolve([]),
  findSimilar: () => Promise.resolve(undefined),
  incrementOccurrence: () => Promise.resolve(),
};

function buildOverlay(
  codeHost: GitHubCodeHost,
  projectId: number,
  headRef: string,
): IOverlayView {
  const cache = new Map<string, string | null>();
  let tree: string[] | null = null;

  async function read(path: string): Promise<string | null> {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    try {
      const content = await codeHost.getFileContent(projectId, headRef, path);
      cache.set(path, content);
      return content;
    } catch {
      cache.set(path, null);
      return null;
    }
  }

  async function listFiles(pattern: string): Promise<string> {
    if (tree === null) {
      const entries = await codeHost.getFileTree(projectId, headRef);
      tree = entries.map((entry) => entry.path);
    }
    const needle = pattern.replace(/\*/g, "");
    const filtered =
      needle.length > 0 ? tree.filter((p) => p.includes(needle)) : tree;
    return filtered.slice(0, 200).join("\n");
  }

  async function readBounded(path: string): Promise<string> {
    const content = await read(path);
    return content === null
      ? `File not found: ${path}`
      : content.slice(0, 6000);
  }

  return {
    createToolExecutor(): (call: ToolCall) => Promise<string> {
      return async (call: ToolCall): Promise<string> => {
        if (call.name === "read_file") {
          const path = call.arguments["path"];
          return typeof path === "string"
            ? readBounded(path)
            : "Invalid arguments: path required";
        }
        if (call.name === "list_files") {
          const pattern =
            typeof call.arguments["pattern"] === "string"
              ? call.arguments["pattern"]
              : "";
          return listFiles(pattern);
        }
        return Promise.resolve("Tool not available in this run.");
      };
    },
    readFile(path: string): Promise<string> {
      return readBounded(path);
    },
    readFileAtBaseline(path: string): Promise<string> {
      return readBounded(path);
    },
    searchContent(): Promise<string> {
      return Promise.resolve("No matches found.");
    },
  };
}

function defaultLogger(provided?: FastifyBaseLogger): FastifyBaseLogger {
  return provided ?? (pino({ level: "warn" }) as unknown as FastifyBaseLogger);
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

/**
 * Locations (path:line) that already carry a comment from our bot on this PR.
 * Used to suppress duplicate inline threads when the same PR is re-reviewed
 * after a new push, so a finding on an unchanged line is never re-posted.
 */
async function existingBotCommentLocations(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  botUsername: string,
): Promise<Set<string>> {
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    { owner, repo, pull_number: pullRequestNumber, per_page: 100 },
  );
  const wanted = botUsername.trim().toLowerCase();
  const locations = new Set<string>();
  for (const comment of comments) {
    const login = comment.user?.login?.toLowerCase() ?? "";
    const isAppBot = comment.user?.type === "Bot" && login.endsWith("[bot]");
    const isNamed = wanted !== "" && login.startsWith(wanted);
    if (!isAppBot && !isNamed) continue;
    for (const line of [comment.line, comment.original_line]) {
      if (line !== null && line !== undefined) {
        locations.add(locationKey(comment.path, line));
      }
    }
  }
  return locations;
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
  const repoMeta = await octokit.rest.repos.get({ owner, repo });
  const versions = await codeHost.getMergeRequestVersions(
    repoMeta.data.id,
    pullRequestNumber,
  );
  return { repoId: repoMeta.data.id, headSha: versions.headSha };
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
  const repositories = await octokit.paginate(
    "GET /installation/repositories",
    { per_page: 100 },
  );
  return repositories.map((repository) => ({
    id: repository.id,
    fullName: repository.full_name,
    isPrivate: repository.private,
    defaultBranch: repository.default_branch,
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

  const repoMeta = await octokit.rest.repos.get({ owner, repo });
  const projectId = repoMeta.data.id;

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

  const llmConfig = new LlmConfig();
  let llm: OllamaClient | OpenRouterClient;
  let reviewModel: string;
  let triageModel: string;
  if (llmConfig.envs.LLM_PROVIDER === "ollama") {
    llm = new OllamaClient(llmConfig, logger);
    reviewModel = llmConfig.envs.OLLAMA_MODEL;
    triageModel = llmConfig.envs.OLLAMA_TRIAGE_MODEL;
  } else {
    const openRouterConfig = new OpenRouterConfig();
    llm = new OpenRouterClient(openRouterConfig, logger);
    reviewModel = openRouterConfig.envs.OPENROUTER_MODEL;
    triageModel = openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL;
  }

  const costBudget = new CostBudget(options.maxCostUsd);

  let context: ReviewContext = {
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
      models: { premium: null, review: reviewModel, triage: triageModel },
    }),
    reviewRunId: "github-pr-review",
    toolCallCache: new Map(),
    versions,
  };

  const passResults = new Map<string, PassResult>();

  const triage = new TriagePass(llm, logger);
  const triageResult = await triage.execute(context, passResults);
  passResults.set("triage", triageResult);
  // PassResult.metadata is an untyped per-pass bag; the triage pass populates it
  // with TriagePassMetadata (trivialKeys), so we narrow to read trivialKeys.
  const triageMeta = triageResult.metadata as unknown as TriagePassMetadata;
  context = {
    ...context,
    diffs: applyTriageFilter(context.diffs, triageMeta.trivialKeys),
  };

  const fileReview = new FileReviewPass(llm, logger);
  passResults.set(
    "file-review",
    await fileReview.execute(context, passResults),
  );

  const partial = costBudget.isExhausted();
  if (partial) {
    logger.warn(
      {
        mrIid: pullRequestNumber,
        projectId,
        spentUsd: costBudget.spent,
      },
      "Per-scan cost ceiling reached: skipping cross-file pass, finalizing partial review",
    );
  } else {
    const crossFile = new CrossFilePass(llm, logger);
    passResults.set(
      "cross-file",
      await crossFile.execute(context, passResults),
    );
  }

  const aggregation = new AggregationPass(noopDismissedPatternRepo, logger, 3);
  passResults.set(
    "aggregation",
    await aggregation.execute(context, passResults),
  );

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

  const models = {
    review: OPENROUTER_REVIEW_MODEL,
    triage: OPENROUTER_TRIAGE_MODEL,
  };
  const tokenCostUsd = computeReviewRunCostUsd(passResults, models);
  const tokenUsageByModel = aggregateTokenUsageByModel(passResults, models);

  const useContentDedup = previousThreads.length > 0;

  let postedCount = 0;
  if (post) {
    const postMode = options.postMode ?? "inline";
    if (postMode === "inline") {
      const alreadyPosted = useContentDedup
        ? new Set<string>()
        : await existingBotCommentLocations(
            octokit,
            owner,
            repo,
            pullRequestNumber,
            githubConfig.envs.GITHUB_BOT_USERNAME,
          );
      for (const finding of postable) {
        const positionResult = buildPosition(finding, versions, parsedDiffs);
        if (!positionResult) continue;
        const targetLine =
          positionResult.position.newLine ?? finding.lineNumber;
        if (
          !useContentDedup &&
          alreadyPosted.has(locationKey(finding.filePath, targetLine))
        ) {
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
        const posted = await codeHost.postInlineComment(
          projectId,
          pullRequestNumber,
          body,
          positionResult.position,
        );
        postedThreadByFinding.set(finding, posted);
        postedCount++;
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
    const summaryBody = `## AI Review — production-readiness: ${String(score.score)}/100 (grade ${score.grade})${partialNote}${incrementalNote}\n\n${buildSummaryNote(
      {
        allFindings,
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
