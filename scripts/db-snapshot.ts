/**
 * One-shot DB snapshot for ai-reviewer review runs.
 *
 * Connects to the same Postgres the service uses (DATABASE_URL or
 * DATABASE_URL_PROD env), pulls last N runs (optionally filtered by mrIid /
 * projectId / triggerType) and prints a readable breakdown:
 *   - per-run: trigger_type, prompt/completion tokens, cost, models, status,
 *     duration, findings counts
 *   - per-pass findings (model breakdown from review_finding table)
 *   - aggregate: totals + average cost per run
 *
 * Examples:
 *   pnpm --filter ai-reviewer db:snapshot --mr 22 --project 76914544
 *   pnpm --filter ai-reviewer db:snapshot --limit 10
 *   pnpm --filter ai-reviewer db:snapshot --trigger main_push --limit 5
 *   DATABASE_URL=postgresql://... pnpm --filter ai-reviewer db:snapshot
 *
 * Flags:
 *   --mr <iid>          filter by merge_request iid
 *   --project <id>      filter by project_id
 *   --trigger <type>    filter by trigger_type (mr_open|push|force_push|main_push|mention|mr_undraft)
 *   --limit <n>         max runs to show (default 5)
 *   --no-color          disable ANSI colors
 *
 * Required env (one of):
 *   DATABASE_URL_PROD   production DSN (preferred — won't conflict with local DB)
 *   DATABASE_URL        fallback DSN (your local dev DB)
 */

import pg from "pg";

const argv = process.argv.slice(2);
const mrIid = parseNumber("--mr");
const projectId = parseNumber("--project");
const triggerType = parseString("--trigger");
const limit = parseNumber("--limit") ?? 5;
const useColor = !argv.includes("--no-color") && process.stdout.isTTY !== false;

const DATABASE_URL =
  process.env["DATABASE_URL_PROD"] ?? process.env["DATABASE_URL"];

if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
  process.stderr.write(
    "ERROR: DATABASE_URL_PROD (preferred) or DATABASE_URL must be set.\n",
  );
  process.exit(1);
}

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

interface RunRow {
  base_commit_sha: string;
  completed_at: Date | null;
  completion_tokens: number | null;
  critical_count: number | null;
  error_message: string | null;
  files_reviewed: number | null;
  head_commit_sha: string;
  id: string;
  is_incremental: boolean;
  mr_iid: number;
  project_id: number;
  prompt_tokens: number | null;
  queued_at: Date;
  review_model: string | null;
  started_at: Date | null;
  status: string;
  total_cost: number | string | null;
  total_findings: number | null;
  triage_model: string | null;
  trigger_type: string;
  warning_count: number | null;
}

interface FindingPassRow {
  count: string;
  model: string;
  pass_name: string;
  severity: string;
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString("en-US");
}

function fmtCost(c: number | string | null): string {
  if (c === null) return "-";
  const num = typeof c === "string" ? Number(c) : c;
  if (!Number.isFinite(num)) return "-";
  return `$${num.toFixed(4)}`;
}

function fmtDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "-";
  const ms = end.getTime() - start.getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string): string {
  if (status === "completed") return COLOR.green;
  if (status === "failed") return COLOR.red;
  if (status === "in_progress") return COLOR.cyan;
  return COLOR.dim;
}

async function main(): Promise<void> {
  const dsnLabel =
    process.env["DATABASE_URL_PROD"] !== undefined ? "PROD" : "DATABASE_URL";
  process.stdout.write(
    `${COLOR.bold}ai-reviewer db:snapshot${COLOR.reset} ${COLOR.dim}(${dsnLabel})${COLOR.reset}\n`,
  );
  process.stdout.write(
    `${COLOR.dim}filter: mr=${String(mrIid ?? "*")} project=${String(projectId ?? "*")} trigger=${triggerType ?? "*"} limit=${limit}${COLOR.reset}\n\n`,
  );

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const runWhere: string[] = [];
    const runParams: unknown[] = [];
    if (projectId !== undefined) {
      runParams.push(projectId);
      runWhere.push(`project_id = $${runParams.length}`);
    }
    if (mrIid !== undefined) {
      runParams.push(mrIid);
      runWhere.push(`mr_iid = $${runParams.length}`);
    }
    if (triggerType !== undefined) {
      runParams.push(triggerType);
      runWhere.push(`trigger_type = $${runParams.length}`);
    }
    runParams.push(limit);
    const limitParam = `$${runParams.length}`;
    const runWhereSql =
      runWhere.length > 0 ? `WHERE ${runWhere.join(" AND ")}` : "";

    const runsResult = await client.query<RunRow>(
      `SELECT id, project_id, mr_iid, trigger_type, status,
              prompt_tokens, completion_tokens, total_cost, total_findings,
              critical_count, warning_count, files_reviewed,
              review_model, triage_model, error_message,
              base_commit_sha, head_commit_sha, is_incremental,
              queued_at, started_at, completed_at
       FROM review_run
       ${runWhereSql}
       ORDER BY queued_at DESC
       LIMIT ${limitParam}`,
      runParams,
    );

    if (runsResult.rows.length === 0) {
      process.stdout.write(
        `${COLOR.yellow}No runs found matching filter.${COLOR.reset}\n`,
      );
      return;
    }

    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCostUsd = 0;

    for (const run of runsResult.rows) {
      const id = run.id.slice(0, 8);
      const proj = run.project_id;
      const mr = run.mr_iid;
      const trigger = run.trigger_type;
      const status = `${statusColor(run.status)}${run.status}${COLOR.reset}`;
      const incremental = run.is_incremental ? " incremental" : "";
      const duration = fmtDuration(run.started_at, run.completed_at);

      process.stdout.write(
        `${COLOR.bold}═══ run ${id} ${COLOR.reset}${COLOR.magenta}MR#${mr}${COLOR.reset} ${COLOR.dim}proj=${proj}${COLOR.reset} ${COLOR.cyan}${trigger}${COLOR.reset}${incremental}  ${status}  ${COLOR.dim}duration=${duration}${COLOR.reset}\n`,
      );

      const promptTok = run.prompt_tokens ?? 0;
      const complTok = run.completion_tokens ?? 0;
      const costNum =
        run.total_cost === null
          ? 0
          : typeof run.total_cost === "string"
            ? Number(run.total_cost)
            : run.total_cost;
      totalPrompt += promptTok;
      totalCompletion += complTok;
      totalCostUsd += Number.isFinite(costNum) ? costNum : 0;

      process.stdout.write(
        `  tokens:    prompt=${fmtNum(promptTok)}  completion=${fmtNum(complTok)}  total=${fmtNum(promptTok + complTok)}  cost=${fmtCost(run.total_cost)}\n`,
      );
      process.stdout.write(
        `  models:    review=${run.review_model ?? "-"}  triage=${run.triage_model ?? "-"}\n`,
      );
      process.stdout.write(
        `  findings:  total=${fmtNum(run.total_findings)}  critical=${fmtNum(run.critical_count)}  warning=${fmtNum(run.warning_count)}  files=${fmtNum(run.files_reviewed)}\n`,
      );
      process.stdout.write(
        `  shas:      base=${run.base_commit_sha.slice(0, 8)}  head=${run.head_commit_sha.slice(0, 8)}\n`,
      );
      if (run.error_message !== null) {
        process.stdout.write(
          `  ${COLOR.red}error:     ${run.error_message}${COLOR.reset}\n`,
        );
      }

      const findingsResult = await client.query<FindingPassRow>(
        `SELECT pass_name, severity, model, COUNT(*)::text AS count
         FROM review_finding
         WHERE review_run_id = $1
         GROUP BY pass_name, severity, model
         ORDER BY pass_name, severity`,
        [run.id],
      );

      if (findingsResult.rows.length > 0) {
        process.stdout.write(
          `  ${COLOR.dim}findings breakdown:${COLOR.reset}\n`,
        );
        for (const f of findingsResult.rows) {
          process.stdout.write(
            `    - ${f.pass_name.padEnd(14)} ${f.severity.padEnd(10)} ${f.model.padEnd(40)} ${f.count}\n`,
          );
        }
      }
      process.stdout.write("\n");
    }

    process.stdout.write(
      `${COLOR.bold}═══ aggregate (${runsResult.rows.length} runs) ═══${COLOR.reset}\n`,
    );
    process.stdout.write(`  total prompt tokens:     ${fmtNum(totalPrompt)}\n`);
    process.stdout.write(
      `  total completion tokens: ${fmtNum(totalCompletion)}\n`,
    );
    process.stdout.write(
      `  total cost:              $${totalCostUsd.toFixed(4)}\n`,
    );
    process.stdout.write(
      `  avg cost per run:        $${(totalCostUsd / runsResult.rows.length).toFixed(4)}\n`,
    );
    process.stdout.write(
      `  avg prompt per run:      ${fmtNum(Math.round(totalPrompt / runsResult.rows.length))}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${COLOR.red}db:snapshot failed:${COLOR.reset} ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
