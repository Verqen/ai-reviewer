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

function parseEmbeddedJson(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
  const rawMsgField = entry["_msg"];
  if (typeof rawMsgField === "string") {
    const inner = parseEmbeddedJson(rawMsgField);
    for (const [k, v] of Object.entries(inner ?? {})) {
      if (entry[k] === undefined) entry[k] = v;
    }
  }
  const msg = toScalarString(entry["msg"] ?? entry["_msg"]);
  if (args.important) {
    const isImportant = IMPORTANT_PATTERNS.some((p) =>
      msg.toLowerCase().includes(p.toLowerCase()),
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
      `Query failed: ${response.status} ${response.statusText}: ${await response.text()}`,
    );
    process.exit(1);
  }
  const text = await response.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  console.log(
    `${COLOR.cyan}# query: ${query} | since: ${args.since} | results: ${lines.length}${COLOR.reset}`,
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
      `Tail failed: ${response.status} ${response.statusText}: ${await response.text()}`,
    );
    process.exit(1);
  }
  if (response.body === null) {
    console.error("Empty response body");
    process.exit(1);
  }
  console.log(
    `${COLOR.cyan}# tailing: ${query} | since: ${args.since} | Ctrl+C to stop${COLOR.reset}`,
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
