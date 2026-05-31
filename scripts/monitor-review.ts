/**
 * Live monitor for ai-reviewer pipeline runs.
 *
 * Reads pino JSON from stdin, prints a focused breakdown of one or more review
 * runs in real time (per-pass tokens, LLM calls, GitLab API calls, skips,
 * cooldowns). Saves the raw stream to JSONL for later forensics.
 *
 * Examples:
 *   # 1. Stream live logs from a Kubernetes pod, filter by mrIid:
 *   kubectl logs -f deployment/ai-reviewer -n <ns> \
 *     | pnpm --filter ai-reviewer monitor --mr 22
 *
 *   # 2. Stream live logs and watch every run:
 *   kubectl logs -f deployment/ai-reviewer -n <ns> \
 *     | pnpm --filter ai-reviewer monitor
 *
 *   # 3. Replay a saved log file:
 *   cat my-trace.log | pnpm --filter ai-reviewer monitor --mr 22
 *
 *   # 4. Local dev mode (sees own service stdout):
 *   pnpm --filter ai-reviewer dev:raw 2>&1 \
 *     | pnpm --filter ai-reviewer monitor
 *
 * Flags:
 *   --mr <iid>          show only events for this merge request iid
 *   --project <id>      show only events for this gitlab project id
 *   --raw               also forward every line to stdout (no filtering)
 *   --no-color          disable ANSI colors
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface PinoLine {
  [key: string]: unknown;
  level: number;
  msg?: string;
  time?: number;
}

interface RunSnapshot {
  costUsd: number;
  endedAt: number | undefined;
  gitlabApiCalls: number;
  gitlabFiles: Set<string>;
  llmCalls: number;
  modelsByPass: Map<string, Set<string>>;
  mrIid: number | undefined;
  passes: Map<string, PassSnapshot>;
  projectId: number | undefined;
  reviewRunId: string;
  skippedPasses: string[];
  startedAt: number;
  totalCompletionTokens: number;
  totalPromptTokens: number;
  triageSkipRate: number | undefined;
  warnings: string[];
}

interface PassSnapshot {
  completionTokens: number;
  durationMs: number | undefined;
  findings: number;
  llmCalls: number;
  promptTokens: number;
  status: "skipped" | "running" | "completed" | "failed";
}

const argv = process.argv.slice(2);
const filterMrIid = parseNumberFlag("--mr");
const filterProjectId = parseNumberFlag("--project");
const forwardRaw = argv.includes("--raw");
const useColor = !argv.includes("--no-color") && process.stdout.isTTY !== false;

function parseNumberFlag(name: string): number | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const COLOR = useColor
  ? {
      bold: "\x1b[1m",
      cyan: "\x1b[36m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      magenta: "\x1b[35m",
      red: "\x1b[31m",
      reset: "\x1b[0m",
      yellow: "\x1b[33m",
    }
  : {
      bold: "",
      cyan: "",
      dim: "",
      green: "",
      magenta: "",
      red: "",
      reset: "",
      yellow: "",
    };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(SCRIPT_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const traceFile = join(
  LOG_DIR,
  `monitor-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
const traceStream = createWriteStream(traceFile, { flags: "a" });

const runs = new Map<string, RunSnapshot>();

function getOrCreateRun(reviewRunId: string, line: PinoLine): RunSnapshot {
  const existing = runs.get(reviewRunId);
  if (existing) {
    if (existing.mrIid === undefined && typeof line["mrIid"] === "number") {
      existing.mrIid = line["mrIid"];
    }
    if (
      existing.projectId === undefined &&
      typeof line["projectId"] === "number"
    ) {
      existing.projectId = line["projectId"];
    }
    return existing;
  }
  const fresh: RunSnapshot = {
    costUsd: 0,
    endedAt: undefined,
    gitlabApiCalls: 0,
    gitlabFiles: new Set(),
    llmCalls: 0,
    modelsByPass: new Map(),
    mrIid: typeof line["mrIid"] === "number" ? line["mrIid"] : undefined,
    passes: new Map(),
    projectId:
      typeof line["projectId"] === "number" ? line["projectId"] : undefined,
    reviewRunId,
    skippedPasses: [],
    startedAt: typeof line.time === "number" ? line.time : Date.now(),
    totalCompletionTokens: 0,
    totalPromptTokens: 0,
    triageSkipRate: undefined,
    warnings: [],
  };
  runs.set(reviewRunId, fresh);
  return fresh;
}

function getOrCreatePass(run: RunSnapshot, name: string): PassSnapshot {
  const existing = run.passes.get(name);
  if (existing) return existing;
  const fresh: PassSnapshot = {
    completionTokens: 0,
    durationMs: undefined,
    findings: 0,
    llmCalls: 0,
    promptTokens: 0,
    status: "running",
  };
  run.passes.set(name, fresh);
  return fresh;
}

function shouldShow(line: PinoLine): boolean {
  if (filterMrIid !== undefined) {
    const v = line["mrIid"];
    if (typeof v !== "number" || v !== filterMrIid) return false;
  }
  if (filterProjectId !== undefined) {
    const v = line["projectId"];
    if (typeof v !== "number" || v !== filterProjectId) return false;
  }
  return true;
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return "??:??:??";
  return new Date(ms).toISOString().slice(11, 19);
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

function levelTag(lvl: number): string {
  if (lvl >= 50) return `${COLOR.red}ERR${COLOR.reset}`;
  if (lvl >= 40) return `${COLOR.yellow}WRN${COLOR.reset}`;
  if (lvl >= 30) return `${COLOR.green}INF${COLOR.reset}`;
  return `${COLOR.cyan}DBG${COLOR.reset}`;
}

function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

function handleLine(line: PinoLine): void {
  if (!shouldShow(line)) return;
  const reviewRunId =
    typeof line["reviewRunId"] === "string" ? line["reviewRunId"] : undefined;
  const msg = typeof line.msg === "string" ? line.msg : "";
  const ts = formatTime(line.time);
  const tag = levelTag(line.level);

  if (reviewRunId !== undefined) {
    const run = getOrCreateRun(reviewRunId, line);
    classifyEvent(run, line, msg);
  }

  if (forwardRaw) {
    emit(`${COLOR.dim}${ts} ${tag}${COLOR.reset} ${msg}`);
    return;
  }

  const formatted = formatInteresting(line, msg, ts, tag);
  if (formatted) emit(formatted);
}

function classifyEvent(run: RunSnapshot, line: PinoLine, msg: string): void {
  const passName =
    typeof line["passName"] === "string" ? line["passName"] : undefined;
  const model = typeof line["model"] === "string" ? line["model"] : undefined;
  const promptTokens =
    typeof line["promptTokens"] === "number" ? line["promptTokens"] : 0;
  const completionTokens =
    typeof line["completionTokens"] === "number" ? line["completionTokens"] : 0;

  if (msg === "Pipeline pass completed" && passName) {
    const pass = getOrCreatePass(run, passName);
    pass.status = "completed";
    pass.promptTokens = promptTokens;
    pass.completionTokens = completionTokens;
    pass.durationMs =
      typeof line["durationMs"] === "number"
        ? line["durationMs"]
        : pass.durationMs;
    pass.findings =
      typeof line["findingsCount"] === "number"
        ? line["findingsCount"]
        : pass.findings;
    run.totalPromptTokens += promptTokens;
    run.totalCompletionTokens += completionTokens;
    if (model) {
      const set = run.modelsByPass.get(passName) ?? new Set<string>();
      set.add(model);
      run.modelsByPass.set(passName, set);
    }
  } else if (msg === "Pipeline pass starting" && passName) {
    getOrCreatePass(run, passName);
  } else if (msg.includes("Pipeline pass skipped") && passName) {
    const pass = getOrCreatePass(run, passName);
    pass.status = "skipped";
    if (!run.skippedPasses.includes(passName)) {
      run.skippedPasses.push(passName);
    }
  } else if (msg === "Cross-file pass skipped") {
    const pass = getOrCreatePass(run, "cross-file");
    pass.status = "skipped";
    if (!run.skippedPasses.includes("cross-file")) {
      run.skippedPasses.push("cross-file");
    }
  } else if (msg.includes("LLM") && msg.includes("call")) {
    run.llmCalls += 1;
    if (passName) {
      const pass = getOrCreatePass(run, passName);
      pass.llmCalls += 1;
    }
  } else if (msg === "GitLab API getFileContent") {
    run.gitlabApiCalls += 1;
    if (typeof line["path"] === "string") {
      run.gitlabFiles.add(line["path"]);
    }
  } else if (msg.includes("triageSkipRate")) {
    if (typeof line["triageSkipRate"] === "number") {
      run.triageSkipRate = line["triageSkipRate"];
    }
  } else if (line.level >= 40 && msg) {
    run.warnings.push(msg);
  }

  if (
    msg === "Review run completed" ||
    msg.includes("review-run completed") ||
    msg === "Run completed"
  ) {
    run.endedAt = typeof line.time === "number" ? line.time : Date.now();
    printRunSummary(run);
  }
}

function formatInteresting(
  line: PinoLine,
  msg: string,
  ts: string,
  tag: string,
): string | null {
  const mr = line["mrIid"];
  const passNameRaw = line["passName"];
  const passName: string =
    typeof passNameRaw === "string" ? passNameRaw : "<unknown>";
  const filePath: string =
    typeof line["path"] === "string" ? line["path"] : "<unknown>";
  const mrTag =
    typeof mr === "number" ? `${COLOR.magenta}MR#${mr}${COLOR.reset} ` : "";

  if (msg === "Pipeline pass starting") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.cyan}▶ ${passName}${COLOR.reset}`;
  }
  if (msg === "Pipeline pass completed") {
    const prompt = Number(line["promptTokens"] ?? 0);
    const completion = Number(line["completionTokens"] ?? 0);
    const findings = Number(line["findingsCount"] ?? 0);
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.green}✓ ${passName}${COLOR.reset}  prompt=${formatNum(prompt)}  completion=${formatNum(completion)}  findings=${formatNum(findings)}`;
  }
  if (
    msg.includes("Pipeline pass skipped") ||
    msg === "Cross-file pass skipped"
  ) {
    const label = passName === "<unknown>" ? "cross-file" : passName;
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.yellow}⊘ ${label} skipped${COLOR.reset}`;
  }
  if (msg === "GitLab API getFileContent") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.dim}gitlab.getFileContent ${filePath}${COLOR.reset}`;
  }
  if (msg === "Within cooldown period; skipping main-push re-review") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.yellow}⏸ main-push cooldown${COLOR.reset}`;
  }
  if (msg === "Enqueued main-push re-review") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.green}↻ main-push re-review enqueued${COLOR.reset}`;
  }
  if (msg === "MR review starting" || msg === "Pipeline run starting") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.bold}▶ run started${COLOR.reset}`;
  }
  if (msg === "Run completed" || msg === "Review run completed") {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.bold}${COLOR.green}✓ run completed${COLOR.reset}`;
  }
  if (line.level >= 40 && msg) {
    return `${COLOR.dim}${ts}${COLOR.reset} ${tag} ${mrTag}${COLOR.yellow}${msg}${COLOR.reset}`;
  }
  return null;
}

function printRunSummary(run: RunSnapshot): void {
  const lines: string[] = [];
  const id = run.reviewRunId.slice(0, 8);
  const mrLabel = run.mrIid !== undefined ? `MR#${run.mrIid}` : "MR?";
  const projLabel =
    run.projectId !== undefined ? `proj=${run.projectId}` : "proj=?";
  const duration =
    run.endedAt !== undefined
      ? `${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`
      : "live";

  lines.push("");
  lines.push(
    `${COLOR.bold}═══ RUN ${id}  ${mrLabel}  ${projLabel}  duration=${duration} ═══${COLOR.reset}`,
  );
  const headers = [
    "pass",
    "status",
    "promptTok",
    "complTok",
    "findings",
    "model",
  ];
  const widths = [14, 10, 10, 10, 9, 28];
  lines.push(
    headers
      .map((h, i) => h.padEnd(widths[i] ?? 12))
      .join("  ")
      .trimEnd(),
  );
  for (const [name, pass] of run.passes) {
    const models = run.modelsByPass.get(name);
    const modelLabel =
      models && models.size > 0 ? [...models].join(",") : "<unknown>";
    const cells = [
      name,
      pass.status,
      formatNum(pass.promptTokens),
      formatNum(pass.completionTokens),
      String(pass.findings),
      modelLabel,
    ];
    lines.push(
      cells
        .map((c, i) => c.padEnd(widths[i] ?? 12))
        .join("  ")
        .trimEnd(),
    );
  }
  lines.push("");
  lines.push(
    `  totals: promptTok=${formatNum(run.totalPromptTokens)}  complTok=${formatNum(run.totalCompletionTokens)}  llmCalls=${run.llmCalls}  gitlabFiles=${run.gitlabFiles.size}/${run.gitlabApiCalls} calls`,
  );
  if (run.skippedPasses.length > 0) {
    lines.push(
      `  ${COLOR.yellow}skipped passes: ${run.skippedPasses.join(", ")}${COLOR.reset}`,
    );
  }
  if (run.warnings.length > 0) {
    lines.push(`  warnings: ${run.warnings.length}`);
  }
  lines.push("");
  emit(lines.join("\n"));
}

function printAllSummary(): void {
  if (runs.size === 0) {
    emit(`${COLOR.dim}No review runs observed.${COLOR.reset}`);
    return;
  }
  for (const run of runs.values()) {
    if (run.endedAt === undefined) printRunSummary(run);
  }
  emit(`${COLOR.dim}Trace saved: ${traceFile}${COLOR.reset}`);
}

emit(
  `${COLOR.bold}ai-reviewer monitor${COLOR.reset}${COLOR.dim}  filter: mr=${
    filterMrIid ?? "*"
  } project=${filterProjectId ?? "*"}  trace=${traceFile}${COLOR.reset}`,
);

const rl = createInterface({ input: process.stdin });

rl.on("line", (raw) => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  let parsed: PinoLine | null = null;
  try {
    parsed = JSON.parse(trimmed) as PinoLine;
  } catch {
    if (forwardRaw) emit(`${COLOR.dim}[non-json] ${trimmed}${COLOR.reset}`);
    return;
  }
  traceStream.write(`${trimmed}\n`);
  handleLine(parsed);
});

rl.on("close", () => {
  printAllSummary();
  traceStream.end();
});

process.on("SIGINT", () => {
  printAllSummary();
  traceStream.end();
  process.exit(0);
});
