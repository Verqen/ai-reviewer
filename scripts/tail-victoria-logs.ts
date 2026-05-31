/**
 * Pulls or tails ai-reviewer logs from VictoriaLogs and prints a readable view.
 *
 * Useful when you want to see what the reviewer did for a specific MR without
 * digging through the VMUI by hand.
 *
 * Examples:
 *   # 1. Show last hour of logs for MR 800:
 *   pnpm --filter ai-reviewer exec tsx scripts/tail-victoria-logs.ts \
 *     --mr 800 --since 1h
 *
 *   # 2. Live tail for MR 800 (Ctrl+C to stop):
 *   pnpm --filter ai-reviewer exec tsx scripts/tail-victoria-logs.ts \
 *     --mr 800 --follow
 *
 *   # 3. Custom server / token:
 *   VL_URL=https://logs.example.com \
 *   VL_TOKEN=... \
 *   pnpm --filter ai-reviewer exec tsx scripts/tail-victoria-logs.ts --mr 800
 *
 *   # 4. Show only key pipeline events (no debug noise):
 *   pnpm --filter ai-reviewer exec tsx scripts/tail-victoria-logs.ts \
 *     --mr 800 --since 30m --important
 *
 * Flags:
 *   --mr <iid>      filter by mrIid
 *   --project <id>  filter by projectId
 *   --since <dur>   how far back to query (5m, 1h, 24h). Default: 30m
 *   --follow        live tail mode (uses /tail endpoint)
 *   --important     only key events (run started/completed, pass completed,
 *                   trigger detected, errors)
 *   --raw           print full JSON line instead of formatted view
 *   --limit <n>     max results for non-follow mode (default 1000)
 *
 * Env:
 *   VL_URL          VictoriaLogs base URL (default https://logs.example.com)
 *   VL_TOKEN        Bearer token if auth is required
 *   VL_TENANT       optional "AccountID:ProjectID" pair
 */

interface CliArgs {
  follow: boolean;
  important: boolean;
  limit: number;
  mr?: number | undefined;
  project?: number | undefined;
  raw: boolean;
  since: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    follow: false,
    important: false,
    limit: 1000,
    mr: undefined,
    project: undefined,
    raw: false,
    since: "30m",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--mr" && next !== undefined) {
      args.mr = Number(next);
      i++;
    } else if (flag === "--project" && next !== undefined) {
      args.project = Number(next);
      i++;
    } else if (flag === "--since" && next !== undefined) {
      args.since = next;
      i++;
    } else if (flag === "--limit" && next !== undefined) {
      args.limit = Number(next);
      i++;
    } else if (flag === "--follow") {
      args.follow = true;
    } else if (flag === "--important") {
      args.important = true;
    } else if (flag === "--raw") {
      args.raw = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(__filename);
      process.exit(0);
    }
  }
  return args;
}

const VL_URL = process.env["VL_URL"] ?? "https://logs.example.com";
const VL_TOKEN = process.env["VL_TOKEN"];
const VL_TENANT = process.env["VL_TENANT"];

const IMPORTANT_PATTERNS = [
  "Pipeline run starting",
  "Pipeline run completed",
  "Pipeline pass completed",
  "Pipeline pass starting",
  "Running incremental review",
  "Running full review",
  "Running main-push scoped",
  "Rebase detected",
  "Force-push detected",
  "Triage batch completed",
  "Triage completed",
  "File review pass completed",
  "Skip-filter applied",
  "Skipping duplicate review",
  "No reviewable changes",
  "Review run completed",
  "Starting MR review",
  "MR review completed",
  "Failed",
  "error",
];

function buildQuery(args: CliArgs): string {
  const parts: string[] = ['kubernetes_container_name:"ai-reviewer"'];
  if (args.mr !== undefined && Number.isFinite(args.mr)) {
    parts.push(`log_parsed.mrIid:"${args.mr}"`);
  }
  if (args.project !== undefined && Number.isFinite(args.project)) {
    parts.push(`log_parsed.projectId:"${args.project}"`);
  }
  return parts.join(" AND ");
}

function defaultHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/stream+json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (VL_TOKEN !== undefined && VL_TOKEN.length > 0) {
    headers["Authorization"] = `Bearer ${VL_TOKEN}`;
  }
  if (VL_TENANT !== undefined && VL_TENANT.length > 0) {
    const [accountId, projectId] = VL_TENANT.split(":");
    if (accountId !== undefined) headers["AccountID"] = accountId;
    if (projectId !== undefined) headers["ProjectID"] = projectId;
  }
  return headers;
}

const COLOR = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};

function levelColor(level: number | string | undefined): string {
  const numeric =
    typeof level === "number"
      ? level
      : typeof level === "string"
        ? Number(level)
        : 30;
  if (numeric >= 50) return COLOR.red;
  if (numeric >= 40) return COLOR.yellow;
  if (numeric >= 30) return COLOR.green;
  return COLOR.dim;
}

function toScalarString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatLine(rawJson: string, args: CliArgs): string | null {
  if (args.raw) {
    return rawJson;
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return rawJson;
  }
  // ai-reviewer logs are pino JSON nested inside _msg as a string
  const rawMsgField = entry["_msg"];
  if (typeof rawMsgField === "string") {
    try {
      const inner = JSON.parse(rawMsgField) as Record<string, unknown>;
      for (const [k, v] of Object.entries(inner)) {
        if (entry[k] === undefined) entry[k] = v;
      }
    } catch {
      // not JSON, keep raw _msg
    }
  }
  const msg = toScalarString(entry["msg"] ?? entry["_msg"]);
  if (args.important) {
    const isImportant = IMPORTANT_PATTERNS.some((p) =>
      msg.toLowerCase().includes(p.toLowerCase())
    );
    if (!isImportant) return null;
  }
  const time = toScalarString(entry["_time"] ?? entry["time"]);
  const shortTime = time.length >= 19 ? time.slice(11, 19) : time;
  const levelRaw = entry["level"];
  const level =
    typeof levelRaw === "number" || typeof levelRaw === "string"
      ? levelRaw
      : undefined;
  const color = levelColor(level);
  const meta: string[] = [];
  for (const key of [
    "mrIid",
    "projectId",
    "passName",
    "triggerType",
    "promptTokens",
    "completionTokens",
    "findingsCount",
    "diffCount",
    "originalCount",
    "reviewableCount",
    "skippedCount",
    "filesSucceeded",
    "filesAbortedNoFinal",
    "filesErrored",
    "totalPromptTokens",
    "totalCompletionTokens",
    "previousBaseSha",
    "currentBaseSha",
    "previousSha",
    "newHeadSha",
    "model",
  ]) {
    const v = entry[key];
    if (v !== undefined && v !== null && v !== "") {
      const asString = toScalarString(v);
      const display = asString.length > 12 ? asString.slice(0, 12) : asString;
      meta.push(`${key}=${display}`);
    }
  }
  const metaStr =
    meta.length > 0 ? ` ${COLOR.dim}{${meta.join(" ")}}${COLOR.reset}` : "";
  return `${COLOR.dim}${shortTime}${COLOR.reset} ${color}${msg}${COLOR.reset}${metaStr}`;
}

async function runQuery(args: CliArgs): Promise<void> {
  const query = buildQuery(args);
  const body = new URLSearchParams({
    limit: String(args.limit),
    query,
    start: `now-${args.since}`,
  });
  const response = await fetch(`${VL_URL}/select/logsql/query`, {
    body: body.toString(),
    headers: defaultHeaders(),
    method: "POST",
  });
  if (!response.ok) {
    console.error(
      `Query failed: ${response.status} ${response.statusText}: ${await response.text()}`
    );
    process.exit(1);
  }
  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  console.log(
    `${COLOR.cyan}# query: ${query} | since: ${args.since} | results: ${lines.length}${COLOR.reset}`
  );
  for (const line of lines) {
    const formatted = formatLine(line, args);
    if (formatted !== null) console.log(formatted);
  }
}

async function runTail(args: CliArgs): Promise<void> {
  const query = buildQuery(args);
  const body = new URLSearchParams({
    query,
    start_offset: args.since,
  });
  const response = await fetch(`${VL_URL}/select/logsql/tail`, {
    body: body.toString(),
    headers: defaultHeaders(),
    method: "POST",
  });
  if (!response.ok) {
    console.error(
      `Tail failed: ${response.status} ${response.statusText}: ${await response.text()}`
    );
    process.exit(1);
  }
  if (response.body === null) {
    console.error("Empty response body");
    process.exit(1);
  }
  console.log(
    `${COLOR.cyan}# tailing: ${query} | since: ${args.since} | Ctrl+C to stop${COLOR.reset}`
  );
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) {
        const formatted = formatLine(line, args);
        if (formatted !== null) console.log(formatted);
      }
      idx = buffer.indexOf("\n");
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.follow) {
    await runTail(args);
  } else {
    await runQuery(args);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
