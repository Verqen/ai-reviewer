/**
 * Trace AI-reviewer events from a pino-JSON stdin stream.
 *
 * Usage:
 *   pnpm --filter ai-reviewer dev 2>&1 | pnpm --filter ai-reviewer trace
 *   # or pipe a saved log:
 *   cat run.log | pnpm --filter ai-reviewer trace
 *
 * What it does:
 *   - Reads pino JSON lines from stdin.
 *   - Filters and pretty-prints events relevant to a single review run:
 *     * webhook events (push, mr, note, @ai mention)
 *     * thread reply path (matching finding lookup, classifyIntent verdict,
 *       answerClarification call, code-host reply)
 *     * pipeline orchestrator (skip-filter counts, triage skip rate)
 *     * each LLM call: model, phase, prompt size, completion size, cost
 *     * any "WARN"/"ERROR" entries
 *   - Saves the full unfiltered stream as JSONL into
 *     scripts/logs/review-trace-<timestamp>.jsonl for offline grep/jq.
 *   - At end (or on SIGINT) prints a summary: total LLM calls per phase,
 *     total tokens (in/out/cached), total skip / triage counts.
 *
 * Tags it understands (no source changes required — driven by pino msg/keys):
 *   - msg containing "Webhook", "MR review", "Tool loop", "Cache", "Triage",
 *     "Skip", "Thread reply", "Responding to @ai"
 *   - top-level fields: mrIid, projectId, model, phase, runId, discussionId,
 *     promptTokens, completionTokens, cachedTokens, costUsd, durationMs
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface PinoLine {
  // arbitrary structured fields
  [key: string]: unknown;
  level: number;
  msg?: string;
  time?: number;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(SCRIPT_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const traceFile = join(
  LOG_DIR,
  `review-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
const traceStream = createWriteStream(traceFile, { flags: "a" });

const COLOR = {
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

const counters = {
  bytesPerCall: [] as number[],
  cachedTokens: 0,
  classifyIntent: 0,
  completionTokens: 0,
  costUsd: 0,
  errors: 0,
  filesSkipped: 0,
  intentByName: {} as Record<string, number>,
  llmCalls: 0,
  promptTokens: 0,
  runs: 0,
  triageTrivial: 0,
  warnings: 0,
};

interface PhaseStats {
  cachedTokens: number;
  calls: number;
  completionTokens: number;
  models: Set<string>;
  promptTokens: number;
}

const phaseStats = new Map<string, PhaseStats>();

function getPhaseStats(phase: string): PhaseStats {
  const existing = phaseStats.get(phase);
  if (existing) return existing;
  const fresh: PhaseStats = {
    cachedTokens: 0,
    calls: 0,
    completionTokens: 0,
    models: new Set<string>(),
    promptTokens: 0,
  };
  phaseStats.set(phase, fresh);
  return fresh;
}

function levelLabel(lvl: number): string {
  if (lvl >= 50) return `${COLOR.red}ERROR${COLOR.reset}`;
  if (lvl >= 40) return `${COLOR.yellow}WARN${COLOR.reset}`;
  if (lvl >= 30) return `${COLOR.green}INFO${COLOR.reset}`;
  if (lvl >= 20) return `${COLOR.cyan}DEBUG${COLOR.reset}`;
  return `${COLOR.dim}TRACE${COLOR.reset}`;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function fmtKv(obj: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      parts.push(`${COLOR.dim}${k}=${COLOR.reset}${stringifyValue(obj[k])}`);
    }
  }
  return parts.join(" ");
}

type LineKind =
  | "thread"
  | "pipeline"
  | "llm"
  | "skip-triage"
  | "webhook"
  | "warn"
  | "error"
  | "budget"
  | "tool-loop"
  | "parse-fail"
  | "other";

function classify(line: PinoLine): LineKind {
  if (line.level >= 50) return "error";
  if (line.level >= 40) return "warn";
  const msg = (line.msg ?? "").toLowerCase();
  if (/prompt token hard limit|budget/i.test(line.msg ?? "")) return "budget";
  if (/tool loop exhausted/i.test(line.msg ?? "")) return "tool-loop";
  if (/failed to parse/i.test(line.msg ?? "")) return "parse-fail";
  if (
    msg.includes("webhook") ||
    msg.includes("@ai") ||
    msg.includes("note received")
  ) {
    return "webhook";
  }
  if (
    msg.includes("thread reply") ||
    msg.includes("clarification") ||
    msg.includes("intent classified") ||
    msg.includes("classified intent") ||
    msg.includes("classifyintent") ||
    msg.includes("matching pending finding") ||
    msg.includes("agreement") ||
    msg.includes("agreed with finding") ||
    line["intent"] !== undefined ||
    line["discussionId"] !== undefined
  ) {
    return "thread";
  }
  if (msg.includes("skip") || msg.includes("triage")) {
    return "skip-triage";
  }
  if (
    msg.includes("openrouter") ||
    msg.includes("ollama") ||
    msg.includes("tool loop") ||
    msg.includes("cache") ||
    line["promptTokens"] !== undefined ||
    line["model"] !== undefined
  ) {
    return "llm";
  }
  if (
    msg.includes("review run") ||
    msg.includes("starting mr review") ||
    msg.includes("pipeline") ||
    line["runId"] !== undefined
  ) {
    return "pipeline";
  }
  return "other";
}

function formatLine(line: PinoLine): string | null {
  const kind = classify(line);
  const time = line.time
    ? new Date(line.time).toISOString().slice(11, 23)
    : "--:--:--.---";
  const lvl = levelLabel(line.level);
  const msg = line.msg ?? "";

  if (kind === "other") return null;

  let extra = "";
  let tag = "";

  switch (kind) {
    case "webhook":
      tag = `${COLOR.cyan}[WEBHOOK]${COLOR.reset}`;
      extra = fmtKv(line, ["projectId", "mrIid", "discussionId", "trigger"]);
      break;
    case "thread":
      tag = `${COLOR.magenta}[THREAD]${COLOR.reset}`;
      extra = fmtKv(line, [
        "projectId",
        "mrIid",
        "discussionId",
        "findingId",
        "intent",
        "rawIntent",
        "reason",
      ]);
      if (typeof line["intent"] === "string") {
        const intentName = line["intent"];
        counters.intentByName[intentName] =
          (counters.intentByName[intentName] ?? 0) + 1;
      }
      break;
    case "skip-triage": {
      tag = `${COLOR.yellow}[TRIAGE]${COLOR.reset}`;
      extra = fmtKv(line, [
        "skippedCount",
        "trivialCount",
        "needsReviewCount",
        "triageSkipRate",
        "reason",
      ]);
      if (typeof line["skippedCount"] === "number") {
        counters.filesSkipped += line["skippedCount"];
      }
      if (typeof line["trivialCount"] === "number") {
        counters.triageTrivial += line["trivialCount"];
      }
      break;
    }
    case "llm": {
      tag = `${COLOR.green}[LLM]${COLOR.reset}`;
      extra = fmtKv(line, [
        "model",
        "phase",
        "promptTokens",
        "completionTokens",
        "cachedTokens",
        "costUsd",
        "durationMs",
      ]);
      counters.llmCalls += 1;
      if (typeof line["promptTokens"] === "number") {
        counters.promptTokens += line["promptTokens"];
      }
      if (typeof line["completionTokens"] === "number") {
        counters.completionTokens += line["completionTokens"];
      }
      if (typeof line["cachedTokens"] === "number") {
        counters.cachedTokens += line["cachedTokens"];
      }
      if (typeof line["costUsd"] === "number") {
        counters.costUsd += line["costUsd"];
      }
      const phase =
        typeof line["phase"] === "string" ? line["phase"] : "unknown";
      const ps = getPhaseStats(phase);
      ps.calls += 1;
      if (typeof line["model"] === "string") {
        ps.models.add(line["model"]);
      }
      if (typeof line["promptTokens"] === "number")
        ps.promptTokens += line["promptTokens"];
      if (typeof line["completionTokens"] === "number")
        ps.completionTokens += line["completionTokens"];
      if (typeof line["cachedTokens"] === "number")
        ps.cachedTokens += line["cachedTokens"];
      break;
    }
    case "pipeline":
      tag = `${COLOR.bold}[PIPE]${COLOR.reset}`;
      extra = fmtKv(line, [
        "projectId",
        "mrIid",
        "runId",
        "triggerType",
        "durationMs",
        "status",
      ]);
      if ((line.msg ?? "").toLowerCase().includes("starting mr review")) {
        counters.runs += 1;
      }
      break;
    case "budget":
      tag = `${COLOR.red}[BUDGET]${COLOR.reset}`;
      counters.warnings += 1;
      extra = fmtKv(line, [
        "estimatedTokens",
        "hardLimit",
        "model",
        "file",
        "phase",
      ]);
      break;
    case "tool-loop":
      tag = `${COLOR.yellow}[TOOL_LOOP]${COLOR.reset}`;
      extra = fmtKv(line, ["maxRounds", "model", "file", "phase"]);
      break;
    case "parse-fail":
      tag = `${COLOR.red}[PARSE_FAIL]${COLOR.reset}`;
      counters.warnings += 1;
      extra = fmtKv(line, ["file", "errors"]);
      if (typeof line["rawContent"] === "string") {
        extra += ` rawContent=${line["rawContent"].slice(0, 200)}`;
      }
      break;
    case "warn":
      tag = `${COLOR.yellow}[WARN]${COLOR.reset}`;
      counters.warnings += 1;
      extra = JSON.stringify(line).slice(0, 300);
      break;
    case "error":
      tag = `${COLOR.red}[ERROR]${COLOR.reset}`;
      counters.errors += 1;
      extra = JSON.stringify(line).slice(0, 500);
      break;
  }

  return `${COLOR.dim}${time}${COLOR.reset} ${lvl} ${tag} ${msg} ${extra}`.trimEnd();
}

function printSummary(): void {
  const cacheHitRate =
    counters.promptTokens > 0
      ? ((counters.cachedTokens / counters.promptTokens) * 100).toFixed(1)
      : "0.0";
  const lines = [
    "",
    `${COLOR.bold}=== TRACE SUMMARY ===${COLOR.reset}`,
    `runs:           ${counters.runs}`,
    `LLM calls:      ${counters.llmCalls}`,
    `prompt tokens:  ${counters.promptTokens.toLocaleString()}`,
    `cached tokens:  ${counters.cachedTokens.toLocaleString()} (${cacheHitRate}% of prompt)`,
    `output tokens:  ${counters.completionTokens.toLocaleString()}`,
    `cost USD:       $${counters.costUsd.toFixed(4)}`,
    `files skipped:  ${counters.filesSkipped}`,
    `triage trivial: ${counters.triageTrivial}`,
    `warnings:       ${counters.warnings}`,
    `errors:         ${counters.errors}`,
  ];

  if (phaseStats.size > 0) {
    lines.push("");
    lines.push(`${COLOR.bold}=== PER-PHASE TOKEN TOTALS ===${COLOR.reset}`);
    const colWidths = {
      cached: 8,
      calls: 6,
      completion: 11,
      model: 38,
      phase: 14,
      prompt: 8,
    };
    const header = [
      "phase".padEnd(colWidths.phase),
      "model(s)".padEnd(colWidths.model),
      "calls".padStart(colWidths.calls),
      "promptTok".padStart(colWidths.prompt),
      "completTok".padStart(colWidths.completion),
      "cachedTok".padStart(colWidths.cached),
    ].join("  ");
    lines.push(`${COLOR.dim}${header}${COLOR.reset}`);
    const sortedPhases = [...phaseStats.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [phase, ps] of sortedPhases) {
      const modelsList =
        ps.models.size === 0
          ? "<unknown>"
          : [...ps.models].sort().join(", ").slice(0, colWidths.model);
      lines.push(
        [
          phase.slice(0, colWidths.phase).padEnd(colWidths.phase),
          modelsList.padEnd(colWidths.model),
          String(ps.calls).padStart(colWidths.calls),
          ps.promptTokens.toLocaleString().padStart(colWidths.prompt),
          ps.completionTokens.toLocaleString().padStart(colWidths.completion),
          ps.cachedTokens.toLocaleString().padStart(colWidths.cached),
        ].join("  "),
      );
    }
  }

  const intentEntries = Object.entries(counters.intentByName);
  if (intentEntries.length > 0) {
    lines.push("");
    lines.push(`${COLOR.bold}=== THREAD INTENTS ===${COLOR.reset}`);
    for (const [intentName, count] of intentEntries.sort(
      ([, a], [, b]) => b - a,
    )) {
      lines.push(`  ${intentName.padEnd(20)} ${count}`);
    }
  }

  lines.push("");
  lines.push(`Full JSONL trace saved to: ${traceFile}`);
  lines.push("");
  process.stderr.write(lines.join("\n"));
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (raw) => {
  if (!raw.trim()) return;
  let parsed: PinoLine | null = null;
  try {
    parsed = JSON.parse(raw) as PinoLine;
  } catch {
    process.stdout.write(`${COLOR.dim}[non-json] ${raw}${COLOR.reset}\n`);
    return;
  }
  traceStream.write(`${raw}\n`);
  const formatted = formatLine(parsed);
  if (formatted) process.stdout.write(`${formatted}\n`);
});

rl.on("close", () => {
  printSummary();
  traceStream.end();
});

process.on("SIGINT", () => {
  printSummary();
  traceStream.end();
  process.exit(0);
});
