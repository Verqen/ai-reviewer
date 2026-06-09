/**
 * Scan a repository locally: take a real git diff between two refs, run the full
 * review pipeline (triage → file-review → cross-file → aggregation) with a real
 * LLM, print per-pass token breakdown and final findings.
 *
 * No code-host API, no Postgres, no webhook. Reads file content via `git show`.
 * Findings are printed, NOT posted anywhere. This is the offline demo of the
 * engine — the same passes the webhook server runs in production.
 *
 * Examples:
 *   # Scan the current repo, feature branch against main
 *   pnpm run scan -- --base main --head HEAD
 *
 *   # Scan an arbitrary repository on disk
 *   pnpm run scan -- --repo /path/to/sample-repo --base main --head HEAD
 *
 *   # Use Ollama instead of OpenRouter (no third-party LLM call)
 *   LLM_PROVIDER=ollama pnpm run scan -- --repo /path/to/sample-repo
 *
 * Flags:
 *   --repo <path>    path to the git repository to scan (default: cwd)
 *   --base <ref>     git ref to diff from (default: main)
 *   --head <ref>     git ref to diff to (default: HEAD)
 *   --max-files <n>  cap files reviewed (default: 30, prevents huge runs)
 *   --no-cross-file  skip cross-file pass
 *   --no-triage      skip triage pass
 *
 * Required env (from .env):
 *   OPENROUTER_API_KEY (if LLM_PROVIDER=openrouter)
 *   OLLAMA_BASE_URL    (if LLM_PROVIDER=ollama)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyBaseLogger } from "fastify";
import { pino } from "pino";

import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { DiffFile } from "~/domain/types/code-host.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Severity } from "~/domain/types/review.types";
import type { ToolCall } from "~/domain/types/llm.types";
import type { ReviewPipelineConfig } from "~/domain/types/config.types";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
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
const BASE_REF = parseString("--base") ?? "main";
const HEAD_REF = parseString("--head") ?? "HEAD";
const MAX_FILES = parseNumber("--max-files") ?? 30;
const SKIP_CROSS_FILE = argv.includes("--no-cross-file");
const SKIP_TRIAGE = argv.includes("--no-triage");
const INCLUDE_RE = parseString("--include");
const includeMatcher = INCLUDE_RE === undefined ? null : new RegExp(INCLUDE_RE);
const RULES_FILE = parseString("--rules-file");
const pathRules =
  RULES_FILE === undefined
    ? undefined
    : (JSON.parse(
        readFileSync(RULES_FILE, "utf8"),
      ) as ReviewPipelineConfig["pathRules"]);

function parseNumber(name: string): number | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseString(name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

const REPO_TARGET = parseString("--repo");
const REPO_ROOT =
  REPO_TARGET !== undefined ? resolve(REPO_TARGET) : process.cwd();

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function gitOrEmpty(args: string): string {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function getDiffFiles(base: string, head: string): DiffFile[] {
  const fileList = git(`diff --name-status ${base}...${head}`).trim();
  if (fileList.length === 0) return [];
  const result: DiffFile[] = [];
  for (const line of fileList.split("\n")) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status === "" || status.startsWith("D")) continue;
    const oldPath = parts[1];
    const newPath = status.startsWith("R") ? parts[2] : oldPath;
    if (oldPath === undefined || newPath === undefined) continue;
    if (includeMatcher !== null && !includeMatcher.test(newPath)) continue;
    const fileDiff = gitOrEmpty(
      `diff --no-color --no-ext-diff -U3 ${base}...${head} -- "${newPath}"`,
    );
    if (fileDiff.trim().length === 0) continue;
    const cleaned = stripGitDiffHeader(fileDiff);
    if (cleaned.length === 0) continue;
    result.push({
      diff: cleaned,
      newPath,
      oldPath: status.startsWith("A") ? newPath : oldPath,
    });
  }
  return result;
}

function stripGitDiffHeader(rawDiff: string): string {
  const lines = rawDiff.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk === -1) return "";
  return lines.slice(firstHunk).join("\n");
}

function getMrInfo(
  base: string,
  head: string,
): {
  description: string;
  title: string;
} {
  const log = gitOrEmpty(`log -1 --format=%B ${head}`).trim();
  const firstLine = log.split("\n")[0] ?? "";
  const rest = log.split("\n").slice(1).join("\n").trim();
  return {
    description: rest || `git diff ${base}...${head} (replay-mr.ts local run)`,
    title: firstLine || `Replay ${base}...${head}`,
  };
}

function buildOverlayView(headRef: string): IOverlayView {
  const cache = new Map<string, string | null>();

  function readFromGit(path: string): string | null {
    if (cache.has(path)) return cache.get(path) ?? null;
    try {
      const content = git(`show ${headRef}:${path}`);
      cache.set(path, content);
      return content;
    } catch {
      cache.set(path, null);
      return null;
    }
  }

  return {
    createToolExecutor(): (call: ToolCall) => Promise<string> {
      return (call: ToolCall): Promise<string> => {
        if (call.name === "read_file") {
          const path = call.arguments["path"];
          if (typeof path !== "string") {
            return Promise.resolve("Invalid arguments: path required");
          }
          const content = readFromGit(path);
          if (content === null)
            return Promise.resolve(`File not found: ${path}`);
          return Promise.resolve(content.slice(0, 6000));
        }
        if (call.name === "list_files") {
          const pattern =
            typeof call.arguments["pattern"] === "string"
              ? call.arguments["pattern"]
              : "";
          const list = gitOrEmpty(`ls-tree -r --name-only ${headRef}`)
            .split("\n")
            .filter((p) => p.length > 0);
          const filtered =
            pattern.length > 0
              ? list.filter((p) => p.includes(pattern.replace(/\*/g, "")))
              : list;
          return Promise.resolve(filtered.slice(0, 200).join("\n"));
        }
        if (call.name === "search_content") {
          const pattern = call.arguments["pattern"];
          if (typeof pattern !== "string") return Promise.resolve("");
          const out = gitOrEmpty(
            `grep -n --fixed-strings ${JSON.stringify(pattern)} ${headRef}`,
          );
          return Promise.resolve(out.split("\n").slice(0, 30).join("\n"));
        }
        return Promise.resolve(`Unknown tool: ${call.name}`);
      };
    },
    readFile(path: string): Promise<string> {
      const content = readFromGit(path);
      if (content === null) return Promise.resolve(`File not found: ${path}`);
      return Promise.resolve(content.slice(0, 6000));
    },
    readFileAtBaseline(path: string): Promise<string> {
      const content = readFromGit(path);
      if (content === null) return Promise.resolve(`File not found: ${path}`);
      return Promise.resolve(content.slice(0, 6000));
    },
    searchContent(pattern: string): Promise<string> {
      const out = gitOrEmpty(
        `grep -n --fixed-strings ${JSON.stringify(pattern)} ${headRef}`,
      );
      if (!out) return Promise.resolve(`No matches found for: ${pattern}`);
      return Promise.resolve(out.split("\n").slice(0, 30).join("\n"));
    },
  };
}

function buildEmptyDismissedRepo(): IDismissedPatternRepository {
  return {
    delete: () => Promise.resolve(),
    findById: () => Promise.resolve(null),
    findByProject: () => Promise.resolve([]),
    incrementOccurrence: () => Promise.resolve(),
    upsert: () => Promise.resolve(),
  } as unknown as IDismissedPatternRepository;
}

interface PhaseResult {
  completionTokens: number;
  durationMs: number;
  findings: number;
  passName: string;
  promptTokens: number;
  status: "ran" | "skipped" | "failed";
}

async function runPass(
  passName: string,
  fn: () => Promise<PassResult>,
): Promise<{ phase: PhaseResult; result: PassResult | null }> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const skipped = (result.metadata as { skipped?: string }).skipped;
    return {
      phase: {
        completionTokens: result.tokenUsage.completionTokens,
        durationMs: Date.now() - startedAt,
        findings: result.findings.length,
        passName,
        promptTokens: result.tokenUsage.promptTokens,
        status: skipped !== undefined ? "skipped" : "ran",
      },
      result,
    };
  } catch (err) {
    process.stderr.write(
      `\n[REPLAY] ${passName} pass FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {
      phase: {
        completionTokens: 0,
        durationMs: Date.now() - startedAt,
        findings: 0,
        passName,
        promptTokens: 0,
        status: "failed",
      },
      result: null,
    };
  }
}

async function main(): Promise<void> {
  process.stderr.write(
    `\n[REPLAY] Repo: ${REPO_ROOT}\n[REPLAY] base=${BASE_REF}  head=${HEAD_REF}  maxFiles=${MAX_FILES.toString()}\n`,
  );

  const allDiffs = getDiffFiles(BASE_REF, HEAD_REF);
  if (allDiffs.length === 0) {
    process.stderr.write(`[REPLAY] No diffs found between refs.\n`);
    process.exit(0);
  }

  const cappedDiffs = allDiffs.slice(0, MAX_FILES);
  if (allDiffs.length > MAX_FILES) {
    process.stderr.write(
      `[REPLAY] Found ${allDiffs.length.toString()} files, capped to ${MAX_FILES.toString()} (override with --max-files)\n`,
    );
  }

  const skippedByReason = new Map<string, string[]>();
  const reviewableDiffs = cappedDiffs.filter((d) => {
    const reason = getPrimarySkipReason(d.newPath);
    if (reason === null) return true;
    const bucket = skippedByReason.get(reason) ?? [];
    bucket.push(d.newPath);
    skippedByReason.set(reason, bucket);
    return false;
  });

  process.stderr.write(
    `[REPLAY] Diff files: ${cappedDiffs.length.toString()} → after skip-filter: ${reviewableDiffs.length.toString()}\n`,
  );
  if (skippedByReason.size > 0) {
    for (const [reason, paths] of skippedByReason) {
      process.stderr.write(
        `  skipped[${reason}] (${paths.length.toString()}):\n${paths.map((p) => `    - ${p}`).join("\n")}\n`,
      );
    }
  }
  process.stderr.write(
    `  reviewable (${reviewableDiffs.length.toString()}):\n${reviewableDiffs.map((d) => `    - ${d.newPath}`).join("\n")}\n`,
  );

  const parsedDiffs = reviewableDiffs.map(parseDiff);

  const logger = pino({ level: "info" }) as unknown as FastifyBaseLogger;

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

  process.stderr.write(
    `[REPLAY] Provider=${llmConfig.envs.LLM_PROVIDER}  review=${reviewModel}  triage=${triageModel}  playbookRules=${(pathRules ?? []).length.toString()}\n\n`,
  );

  const mrInfo = getMrInfo(BASE_REF, HEAD_REF);
  const headSha = git(`rev-parse ${HEAD_REF}`).trim();
  const baseSha = git(`rev-parse ${BASE_REF}`).trim();

  let context: ReviewContext = {
    diffs: parsedDiffs,
    isIncremental: false,
    mrIid: 0,
    mrInfo: {
      description: mrInfo.description,
      iid: 0,
      projectId: 0,
      sourceBranch: HEAD_REF,
      targetBranch: BASE_REF,
      title: mrInfo.title,
    },
    overlayView: buildOverlayView(HEAD_REF),
    previousFindings: [],
    projectId: 0,
    reviewConfig: createMockReviewConfig({
      modelOverrides: { review: true, triage: true },
      models: { premium: null, review: reviewModel, triage: triageModel },
      ...(pathRules ? { pathRules } : {}),
    }),
    reviewRunId: "replay-run",
    toolCallCache: new Map(),
    versions: { baseSha, headSha, startSha: baseSha },
  };

  const passResults = new Map<string, PassResult>();
  const phases: PhaseResult[] = [];

  if (!SKIP_TRIAGE) {
    process.stderr.write(`[REPLAY] ▶ triage\n`);
    const triage = new TriagePass(llm, logger);
    const out = await runPass("triage", () =>
      triage.execute(context, passResults),
    );
    phases.push(out.phase);
    if (out.result) {
      passResults.set("triage", out.result);
      const triageMeta = out.result.metadata as TriagePassMetadata;
      const filteredDiffs = applyTriageFilter(
        context.diffs,
        triageMeta.trivialKeys,
      );
      const removedFiles = context.diffs.length - filteredDiffs.length;
      process.stderr.write(
        `[REPLAY] triage filter: ${context.diffs.length.toString()} → ${filteredDiffs.length.toString()} files (${removedFiles.toString()} fully-trivial files removed; ${triageMeta.trivialHunkCount.toString()} trivial hunks; parseFailures=${triageMeta.parseFailures.toString()}/${triageMeta.totalBatches.toString()})\n`,
      );
      context = { ...context, diffs: filteredDiffs };
    }
  }

  process.stderr.write(
    `[REPLAY] ▶ file-review (${context.diffs.length.toString()} files)\n`,
  );
  const fileReview = new FileReviewPass(llm, logger);
  const fileReviewOut = await runPass("file-review", () =>
    fileReview.execute(context, passResults),
  );
  phases.push(fileReviewOut.phase);
  if (fileReviewOut.result)
    passResults.set("file-review", fileReviewOut.result);

  if (!SKIP_CROSS_FILE) {
    process.stderr.write(`[REPLAY] ▶ cross-file\n`);
    const crossFile = new CrossFilePass(llm, logger);
    const out = await runPass("cross-file", () =>
      crossFile.execute(context, passResults),
    );
    phases.push(out.phase);
    if (out.result) passResults.set("cross-file", out.result);
  }

  process.stderr.write(`[REPLAY] ▶ aggregation\n`);
  const aggregation = new AggregationPass(buildEmptyDismissedRepo(), logger, 3);
  const aggOut = await runPass("aggregation", () =>
    aggregation.execute(context, passResults),
  );
  phases.push(aggOut.phase);
  if (aggOut.result) passResults.set("aggregation", aggOut.result);

  printSummary(phases, passResults);
  printGitLabPreview(passResults, context, parsedDiffs);
  enforceOffDiffInvariant(passResults, reviewableDiffs);
}

function findOffDiffFindings(
  passResults: Map<string, PassResult>,
  allowedPaths: Set<string>,
): Array<{
  filePath: string;
  lineNumber: number;
  passName: string;
  severity: string;
}> {
  const leaks: Array<{
    filePath: string;
    lineNumber: number;
    passName: string;
    severity: string;
  }> = [];
  for (const [passName, result] of passResults) {
    for (const f of result.findings) {
      if (!allowedPaths.has(f.filePath)) {
        leaks.push({
          filePath: f.filePath,
          lineNumber: f.lineNumber,
          passName,
          severity: f.severity,
        });
      }
    }
  }
  return leaks;
}

function printSummary(
  phases: PhaseResult[],
  passResults: Map<string, PassResult>,
): void {
  process.stderr.write(`\n═══ REPLAY SUMMARY ═══\n`);
  const headers = [
    "pass",
    "status",
    "promptTok",
    "complTok",
    "findings",
    "duration",
  ];
  const widths = [14, 9, 12, 12, 9, 9];
  process.stderr.write(
    headers.map((h, i) => h.padEnd(widths[i] ?? 12)).join("  ") + "\n",
  );
  let totalPrompt = 0;
  let totalCompl = 0;
  for (const p of phases) {
    totalPrompt += p.promptTokens;
    totalCompl += p.completionTokens;
    process.stderr.write(
      [
        p.passName,
        p.status,
        p.promptTokens.toLocaleString("en-US"),
        p.completionTokens.toLocaleString("en-US"),
        String(p.findings),
        `${(p.durationMs / 1000).toFixed(1)}s`,
      ]
        .map((c, i) => c.padEnd(widths[i] ?? 12))
        .join("  ") + "\n",
    );
  }
  process.stderr.write(
    `\n  totals: promptTok=${totalPrompt.toLocaleString("en-US")}  complTok=${totalCompl.toLocaleString("en-US")}  total=${(totalPrompt + totalCompl).toLocaleString("en-US")}\n`,
  );

  const aggMeta = passResults.get("aggregation")?.metadata as
    | {
        allFindings?: {
          category: string;
          comment: string;
          filePath: string;
          lineNumber: number;
          passName?: string;
          severity: Severity;
        }[];
      }
    | undefined;
  const allFindings = aggMeta?.allFindings ?? [];
  if (allFindings.length > 0) {
    process.stderr.write(
      `\n═══ FINDINGS (${String(allFindings.length)}) ═══\n`,
    );
    for (const f of allFindings.slice(0, 30)) {
      process.stderr.write(
        `  [${f.severity}] ${f.filePath}:${String(f.lineNumber)} (${f.category})\n    ${f.comment.slice(0, 200)}\n`,
      );
    }
    if (allFindings.length > 30) {
      process.stderr.write(
        `  ... and ${String(allFindings.length - 30)} more findings\n`,
      );
    }
  } else {
    process.stderr.write(`\n  no findings produced\n`);
  }

  const scoreResult = computeProductionReadinessScore(allFindings);
  process.stderr.write(
    `\n═══ PRODUCTION-READINESS SCORE ═══\n` +
      `  ${String(scoreResult.score)}/100   grade ${scoreResult.grade}\n`,
  );
  for (const entry of scoreResult.breakdown) {
    process.stderr.write(
      `  ${entry.category.padEnd(22)} ${String(entry.subscore).padStart(3)}/100  ` +
        `weight ${String(Math.round(entry.weight * 100))}%  (${String(entry.findingCount)} finding(s))\n`,
    );
  }

  const isVisible = (sev: string): boolean =>
    sev === "critical" || sev === "attention" || sev === "warning";
  const fmtSummaryComment = (c: string): string =>
    c.replace(/\r?\n/g, " ").trim();
  const fileTop = allFindings.filter(
    (f) => isVisible(f.severity) && f.passName === "file-review",
  );
  const archTop = allFindings.filter(
    (f) => isVisible(f.severity) && f.passName === "cross-file",
  );
  if (fileTop.length > 0 || archTop.length > 0) {
    process.stderr.write(
      `\n═══ SUMMARY FINDINGS PREVIEW (as it appears in the MR note) ═══\n`,
    );
    if (fileTop.length > 0) {
      process.stderr.write(`\n--- File Findings ---\n`);
      fileTop.forEach((f, i) =>
        process.stderr.write(
          `  ${String(i + 1)}. [${f.severity.toUpperCase()}] ${f.filePath}:${String(f.lineNumber)} - ${fmtSummaryComment(f.comment)}\n`,
        ),
      );
    }
    if (archTop.length > 0) {
      process.stderr.write(`\n--- Architecture Findings ---\n`);
      archTop.forEach((f, i) =>
        process.stderr.write(
          `  ${String(i + 1)}. [${f.severity.toUpperCase()}] ${f.filePath}:${String(f.lineNumber)} - ${fmtSummaryComment(f.comment)}\n`,
        ),
      );
    }
  }

  process.stderr.write("\n");
}

function printGitLabPreview(
  passResults: Map<string, PassResult>,
  context: ReviewContext,
  parsedDiffs: ParsedFileDiff[],
): void {
  const aggMeta = passResults.get("aggregation")?.metadata as
    | {
        allFindings?: Finding[];
        postableFindings?: Finding[];
        suppressedCount?: number;
      }
    | undefined;
  const allFindings = aggMeta?.allFindings ?? [];
  const postableFindings = aggMeta?.postableFindings ?? [];
  const suppressedCount = aggMeta?.suppressedCount ?? 0;

  const tokensByModel = new Map<
    string,
    { completionTokens: number; promptTokens: number }
  >();
  for (const result of passResults.values()) {
    if (!result.tokenUsageByModel) continue;
    for (const [modelName, usage] of Object.entries(result.tokenUsageByModel)) {
      const existing = tokensByModel.get(modelName) ?? {
        completionTokens: 0,
        promptTokens: 0,
      };
      tokensByModel.set(modelName, {
        completionTokens: existing.completionTokens + usage.completionTokens,
        promptTokens: existing.promptTokens + usage.promptTokens,
      });
    }
  }

  process.stderr.write(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  GITLAB MR PREVIEW (what reviewers see in GitLab)\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  if (postableFindings.length === 0) {
    process.stderr.write(`\n[no inline threads — postableFindings is empty]\n`);
  } else {
    process.stderr.write(
      `\n--- INLINE THREADS (${String(postableFindings.length)}) ---\n` +
        `Each block below = a separate inline thread in GitLab on a specific line.\n`,
    );
    let threadIdx = 0;
    let droppedNoPosition = 0;
    for (const finding of postableFindings) {
      const positionResult = buildPosition(
        finding,
        context.versions,
        parsedDiffs,
      );
      if (!positionResult) {
        droppedNoPosition++;
        process.stderr.write(
          `\n  ⚠ NO POSITION (would NOT post inline, only in summary):\n` +
            `    file=${finding.filePath}:${String(finding.lineNumber)} pass=${finding.passName} severity=${finding.severity}\n` +
            `    comment: ${finding.comment.slice(0, 200)}\n`,
        );
        continue;
      }
      const { position, snappedFromLine } = positionResult;
      const snappedComment =
        snappedFromLine !== undefined && position.newLine !== undefined
          ? `${finding.comment}\n\n_[Snapped from L${String(snappedFromLine)} → L${String(position.newLine)}: original line is outside the diff hunk]_`
          : finding.comment;
      const commentBody = formatCommentWithSuggestion(
        snappedComment,
        finding.severity,
        finding.suggestion,
        finding.originalSnippet,
        finding.lineType,
        position.newLine ?? finding.lineNumber,
        finding.endLineNumber,
      );
      threadIdx++;
      const targetLine = position.newLine ?? position.oldLine ?? "?";
      const snapBadge =
        snappedFromLine !== undefined
          ? ` (snapped from L${String(snappedFromLine)})`
          : "";
      process.stderr.write(
        `\n  ── thread #${String(threadIdx)} ─────────────────────────────────────\n` +
          `  📍 ${position.newPath}:L${String(targetLine)}${snapBadge}  pass=${finding.passName}\n` +
          commentBody
            .split("\n")
            .map((l) => `  │ ${l}`)
            .join("\n") +
          "\n",
      );
    }
    if (droppedNoPosition > 0) {
      process.stderr.write(
        `\n  (${String(droppedNoPosition)} finding(s) without inline position — only in summary)\n`,
      );
    }
  }

  const summaryNote = buildSummaryNote({
    allFindings,
    overview:
      allFindings.length === 0
        ? "AI review complete — no issues found."
        : `AI review complete: ${String(allFindings.length)} finding(s), ${String(postableFindings.length)} posted inline.`,
    postableFindings,
    suppressedCount,
    tokenUsageByModel: Object.fromEntries(tokensByModel),
  });

  process.stderr.write(
    `\n--- SUMMARY NOTE (single canvas of the overall MR note) ---\n` +
      summaryNote
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n") +
      "\n\n",
  );
}

function enforceOffDiffInvariant(
  passResults: Map<string, PassResult>,
  reviewableDiffs: DiffFile[],
): void {
  const allowedPaths = new Set(reviewableDiffs.map((d) => d.newPath));
  const leaks = findOffDiffFindings(passResults, allowedPaths);
  if (leaks.length > 0) {
    process.stderr.write(`\n═══ OFF-DIFF LEAK DETECTED ═══\n`);
    for (const leak of leaks) {
      process.stderr.write(
        `  [OFF-DIFF LEAK] pass=${leak.passName} file=${leak.filePath}:${String(leak.lineNumber)} severity=${leak.severity}\n`,
      );
    }
    process.stderr.write(
      `\nTotal leaks: ${String(leaks.length)} — failing replay (exit 1)\n\n`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\n[REPLAY] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
