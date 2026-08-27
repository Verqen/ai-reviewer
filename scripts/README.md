# scripts/

Operator and development entry points. Everything here is a thin CLI over code in `src/`; none of it is imported by the server.

Source files carry no comments (see `CLAUDE.md`) — this file is where their usage lives.

## quickstart — the shortest path to a result

`pnpm quickstart` (`scripts/quickstart.ts`)

Interactive entry point for someone who has just cloned the repository. Asks for an `OPENROUTER_API_KEY` if `.env` does not already carry one (writing it in place, without disturbing the rest of the file), then for a repository path and the two refs to compare. It runs `scan` with those answers rather than reimplementing anything, so the two entry points cannot drift.

Needs a terminal. In CI or a pipe it prints the equivalent `scan` command and exits non-zero.

## scan — run the pipeline over a local git diff

`pnpm run scan -- [flags]` (`scripts/replay-mr.ts`)

Takes a real diff between two git refs, runs the full pipeline (triage → file-review → cross-file → aggregation) against a real LLM, and prints the per-pass token breakdown and the findings. No code host, no Postgres, no webhook: file content is read with `git show`, and nothing is posted anywhere.

| Flag               | Meaning                                             |
| ------------------ | --------------------------------------------------- |
| `--repo <path>`    | repository to scan (default: current directory)     |
| `--base <ref>`     | ref to diff from (default: `main`)                  |
| `--head <ref>`     | ref to diff to (default: `HEAD`)                    |
| `--max-files <n>`  | cap on files reviewed (default: 30)                 |
| `--include <re>`   | only review files whose path matches the expression |
| `--rules-file <p>` | inject a review playbook from this file             |
| `--no-cross-file`  | skip the cross-file pass                            |
| `--no-triage`      | skip the triage pass                                |

Needs `OPENROUTER_API_KEY`, or `LLM_PROVIDER=ollama` plus `OLLAMA_BASE_URL`.

```bash
pnpm run scan -- --base main --head HEAD
pnpm run scan -- --repo /path/to/repo --base main --head HEAD
LLM_PROVIDER=ollama pnpm run scan -- --repo /path/to/repo
```

## review:github — review a real pull request

`pnpm run review:github -- --owner <login> --repo <name> --pr <number> [--dry-run]` (`scripts/review-github-pr.ts`)

The GitHub equivalent of `scan`, but it writes: inline review threads plus a summary note with the production-readiness score. `--dry-run` runs the whole pipeline and posts nothing. Owner, repo and PR number are required.

Needs `CODE_HOST_PROVIDER=github`, GitHub App credentials, and an LLM provider key.

## smoke:llm — check the configured provider

`pnpm run smoke:llm` / `pnpm run smoke:llm:ollama` / `pnpm run smoke:llm:openrouter` (`scripts/smoke-llm.ts`)

Three probes against the review model and, if different, the triage model: a plain completion, a tool-calling completion (required by the cross-file pass and mention threads), and a JSON-schema response (required by triage and file-review). A model that hangs in a tool loop shows up on the timer immediately.

## smoke:triage — one triage batch against Ollama

`pnpm run smoke:triage` (`scripts/triage-smoke.ts`)

Runs the triage pass alone against a local Ollama, to see how a model classifies hunks before spending on the review model.

## trace — follow one run in a log stream

`pnpm run trace` (`scripts/trace-review.ts`)

Reads pino JSON from stdin and pretty-prints the events of a single review run: webhook events, the thread-reply path, orchestrator skip and triage counts, every LLM call with model / phase / sizes / cost, and all warnings and errors. Saves the unfiltered stream to `scripts/logs/review-trace-<timestamp>.jsonl` and prints per-phase totals on exit.

```bash
pnpm dev 2>&1 | pnpm run trace
cat run.log | pnpm run trace
```

## monitor — live per-MR view of the running service

`pnpm run monitor -- [flags]` (`scripts/monitor-review.ts`)

Same input as `trace`, but focused on one or more merge requests at a time: per-pass tokens, LLM calls, code-host calls, skips and cooldowns, updated as they arrive.

| Flag             | Meaning                            |
| ---------------- | ---------------------------------- |
| `--mr <iid>`     | only this merge request            |
| `--project <id>` | only this project                  |
| `--raw`          | also forward every line unfiltered |
| `--no-color`     | disable ANSI colours               |

## db:snapshot — what did the last runs cost

`pnpm run db:snapshot -- [flags]` (`scripts/db-snapshot.ts`)

Reads the service database and prints the last N review runs: trigger type, prompt and completion tokens, cost, models, status, duration, finding counts, per-pass findings, and the aggregate with average cost per run.

| Flag               | Meaning                            |
| ------------------ | ---------------------------------- |
| `--mr <iid>`       | filter by merge-request iid        |
| `--project <id>`   | filter by project id               |
| `--trigger <type>` | filter by trigger type             |
| `--limit <n>`      | how many runs to show (default: 5) |
| `--no-color`       | disable ANSI colours               |

Reads `DATABASE_URL_PROD` if set, otherwise `DATABASE_URL`.

## acceptance-cross-file — does the cross-file pass still catch a cascade

`pnpm exec tsx scripts/acceptance-cross-file.ts`

Changes a core utility function and makes three files depend on it, then asserts that the cross-file pass reports the cascading impact. Exits 0 when the chain is caught, 1 when it is missed or the response fails to parse.

## tail-victoria-logs — read logs from a VictoriaLogs server

`pnpm exec tsx scripts/tail-victoria-logs.ts [flags]`

For deployments that ship logs to VictoriaLogs. Queries or live-tails the reviewer's logs filtered by merge request or project.

| Flag             | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `--mr <iid>`     | filter by merge-request iid                             |
| `--project <id>` | filter by project id                                    |
| `--since <dur>`  | how far back to query, e.g. `5m`, `1h` (default: `30m`) |
| `--follow`       | live tail                                               |
| `--important`    | only run/pass/trigger/error events                      |
| `--raw`          | print the full JSON line                                |
| `--limit <n>`    | max results outside follow mode (default: 1000)         |

Configured with `VL_URL`, `VL_TOKEN` and an optional `VL_TENANT`.
