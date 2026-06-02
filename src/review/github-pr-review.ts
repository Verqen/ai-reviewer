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
import type { Finding, Severity } from "~/domain/types/review.types";
import {
  createGitHubOctokit,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
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
import { buildPosition } from "~/review/finding-inline-position";
import { computeProductionReadinessScore } from "~/review/scoring.service";
import type { Grade } from "~/review/scoring.service";

/**
 * How much to post back to the PR when `post` is true. `inline` posts inline
 * threads plus a summary note (the full review); `summary` posts only the
 * summary note, leaving the diff uncluttered.
 */
export type GitHubReviewPostMode = "inline" | "summary";

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
  logger?: FastifyBaseLogger;
}

/** A finding in a transport-neutral shape, ready to persist or render. */
export interface ReviewedFinding {
  severity: Severity;
  category: string;
  filePath: string;
  line: number;
  comment: string;
  suggestion: string | null;
  /** Anchored to an exact diff position (postable inline). */
  anchored: boolean;
}

export interface GitHubPullRequestReviewResult {
  /** Provider-side repository id. */
  repoId: number;
  score: number;
  grade: Grade;
  findings: ReviewedFinding[];
  /** Inline threads actually posted (0 unless `post` was true). */
  postedCount: number;
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
  const diffFiles = await codeHost.getMergeRequestDiff(
    projectId,
    pullRequestNumber,
  );

  const reviewable = diffFiles.filter(
    (file) => getPrimarySkipReason(file.newPath) === null,
  );
  const parsedDiffs = reviewable.map(parseDiff);

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

  let context: ReviewContext = {
    diffs: parsedDiffs,
    isIncremental: false,
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

  const crossFile = new CrossFilePass(llm, logger);
  passResults.set("cross-file", await crossFile.execute(context, passResults));

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
  const score = computeProductionReadinessScore(allFindings);

  const postableSet = new Set(postable);
  const findings: ReviewedFinding[] = allFindings.map((finding) => ({
    severity: finding.severity,
    category: finding.category,
    filePath: finding.filePath,
    line: finding.lineNumber,
    comment: finding.comment,
    suggestion: finding.suggestion ?? null,
    anchored: postableSet.has(finding),
  }));

  let postedCount = 0;
  if (post) {
    const postMode = options.postMode ?? "inline";
    if (postMode === "inline") {
      const alreadyPosted = await existingBotCommentLocations(
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
        await codeHost.postInlineComment(
          projectId,
          pullRequestNumber,
          body,
          positionResult.position,
        );
        postedCount++;
      }
    }

    const summaryNote = `## AI Review — production-readiness: ${String(score.score)}/100 (grade ${score.grade})\n\n${buildSummaryNote(
      {
        allFindings,
        overview:
          allFindings.length === 0
            ? "No issues found."
            : `${String(allFindings.length)} finding(s); ${String(postedCount)} posted inline.`,
        postableFindings: postable,
        suppressedCount,
        tokenUsageByModel: {},
      },
    )}`;
    await codeHost.postNote(projectId, pullRequestNumber, summaryNote);
  }

  const tokenCostUsd = computeReviewRunCostUsd(passResults, {
    review: OPENROUTER_REVIEW_MODEL,
    triage: OPENROUTER_TRIAGE_MODEL,
  });

  return {
    repoId: projectId,
    score: score.score,
    grade: score.grade,
    findings,
    postedCount,
    tokenCostUsd,
  };
}
