/**
 * Review a real GitHub pull request end-to-end through the GitHub adapter:
 * fetch the PR diff via the app installation, run the full pipeline (triage →
 * file-review → cross-file → aggregation) with a real LLM, then POST inline
 * review-comment threads + a summary note (with the production-readiness score)
 * onto the PR. This is the GitHub equivalent of `scan`, but it writes to GitHub.
 *
 * Examples:
 *   pnpm run review:github -- --owner gkosach --repo test-mr --pr 1
 *   pnpm run review:github -- --owner gkosach --repo test-mr --pr 1 --dry-run
 *
 * Flags:
 *   --owner <login>  repo owner (default: gkosach)
 *   --repo <name>    repo name (default: test-mr)
 *   --pr <number>    pull request number (default: 1)
 *   --dry-run        run the review but DO NOT post anything to GitHub
 *
 * Required env (from .env): CODE_HOST_PROVIDER=github + GitHub App credentials,
 * and an LLM provider key (OPENROUTER_API_KEY or Ollama).
 */

import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";

import { GitHubConfig } from "~/config/github.config";
import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ToolCall } from "~/domain/types/llm.types";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
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
  TriagePass,
  type TriagePassMetadata,
} from "~/pipeline/passes/triage.pass";
import { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
import { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";
import { parseDiff } from "~/review/diff-parser";
import { buildPosition } from "~/review/finding-inline-position";
import { computeProductionReadinessScore } from "~/review/scoring.service";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

const argv = process.argv.slice(2);

function parseString(name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
}

function parseNumber(name: string): number | undefined {
  const value = parseString(name);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

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

async function main(): Promise<void> {
  const owner = parseString("--owner") ?? "gkosach";
  const repo = parseString("--repo") ?? "test-mr";
  const prNumber = parseNumber("--pr") ?? 1;
  const dryRun = argv.includes("--dry-run");

  const logger = pino({ level: "warn" }) as unknown as FastifyBaseLogger;
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig);
  const codeHost = new GitHubCodeHost(octokit, githubConfig, logger);

  const repoMeta = await octokit.rest.repos.get({ owner, repo });
  const projectId = repoMeta.data.id;
  process.stderr.write(
    `\n[GH-REVIEW] ${owner}/${repo}#${String(prNumber)} (repoId=${String(projectId)})  ${dryRun ? "DRY-RUN" : "POSTING"}\n`,
  );

  const mrInfo = await codeHost.getMergeRequestInfo(projectId, prNumber);
  const versions = await codeHost.getMergeRequestVersions(projectId, prNumber);
  const diffFiles = await codeHost.getMergeRequestDiff(projectId, prNumber);

  const reviewable = diffFiles.filter(
    (file) => getPrimarySkipReason(file.newPath) === null,
  );
  process.stderr.write(
    `[GH-REVIEW] diff files: ${String(diffFiles.length)} → reviewable: ${String(reviewable.length)}\n`,
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
  process.stderr.write(`[GH-REVIEW] review model: ${reviewModel}\n`);

  let context: ReviewContext = {
    diffs: parsedDiffs,
    isIncremental: false,
    mrIid: prNumber,
    mrInfo: {
      description: mrInfo.description,
      iid: prNumber,
      projectId,
      sourceBranch: mrInfo.sourceBranch,
      targetBranch: mrInfo.targetBranch,
      title: mrInfo.title,
    },
    overlayView: buildOverlay(codeHost, projectId, versions.headSha),
    previousFindings: [],
    projectId,
    reviewConfig: createMockReviewConfig({
      modelOverrides: { review: true, triage: true },
      models: { premium: null, review: reviewModel, triage: triageModel },
    }),
    reviewRunId: "github-review",
    toolCallCache: new Map(),
    versions,
  };

  const passResults = new Map<string, PassResult>();

  const triage = new TriagePass(llm, logger);
  const triageResult = await triage.execute(context, passResults);
  passResults.set("triage", triageResult);
  const triageMeta = triageResult.metadata as unknown as TriagePassMetadata;
  context = {
    ...context,
    diffs: applyTriageFilter(context.diffs, triageMeta.trivialKeys),
  };
  process.stderr.write(`[GH-REVIEW] ▶ file-review\n`);
  const fileReview = new FileReviewPass(llm, logger);
  passResults.set(
    "file-review",
    await fileReview.execute(context, passResults),
  );

  const crossFile = new CrossFilePass(llm, logger);
  passResults.set("cross-file", await crossFile.execute(context, passResults));

  const aggregation = new AggregationPass(
    {
      delete: () => Promise.resolve(),
      findByProject: () => Promise.resolve([]),
      incrementOccurrence: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    } as never,
    logger,
    3,
  );
  passResults.set(
    "aggregation",
    await aggregation.execute(context, passResults),
  );

  const aggMeta = passResults.get("aggregation")?.metadata as
    | {
        allFindings?: Finding[];
        postableFindings?: Finding[];
        suppressedCount?: number;
      }
    | undefined;
  const allFindings = aggMeta?.allFindings ?? [];
  const postable = aggMeta?.postableFindings ?? [];
  const score = computeProductionReadinessScore(allFindings);

  process.stderr.write(
    `\n[GH-REVIEW] findings: ${String(allFindings.length)}  postable: ${String(postable.length)}  score: ${String(score.score)}/100 (${score.grade})\n`,
  );

  let posted = 0;
  for (const finding of postable) {
    const positionResult = buildPosition(finding, versions, parsedDiffs);
    if (!positionResult) continue;
    const body = formatCommentWithSuggestion(
      finding.comment,
      finding.severity,
      finding.suggestion,
      finding.originalSnippet,
      finding.lineType,
      positionResult.position.newLine ?? finding.lineNumber,
      finding.endLineNumber,
    );
    if (!dryRun) {
      await codeHost.postInlineComment(
        projectId,
        prNumber,
        body,
        positionResult.position,
      );
    }
    posted++;
  }

  const summaryNote = `## AI Review — production-readiness: ${String(score.score)}/100 (grade ${score.grade})\n\n${buildSummaryNote(
    {
      allFindings,
      overview:
        allFindings.length === 0
          ? "No issues found."
          : `${String(allFindings.length)} finding(s); ${String(posted)} posted inline.`,
      postableFindings: postable,
      suppressedCount: aggMeta?.suppressedCount ?? 0,
      tokenUsageByModel: {},
    },
  )}`;
  if (!dryRun) {
    await codeHost.postNote(projectId, prNumber, summaryNote);
  }

  process.stderr.write(
    `[GH-REVIEW] ${dryRun ? "would post" : "posted"} ${String(posted)} inline thread(s) + 1 summary → https://github.com/${owner}/${repo}/pull/${String(prNumber)}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\n[GH-REVIEW] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
