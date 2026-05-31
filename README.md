# @gkosach/core — AI Reviewer

Open-source, self-hostable AI code review pipeline.

Multi-pass review (skip-filter → triage → file-review → cross-file → aggregation), anchor-based grounding so the bot can only post on real diff lines, import-path-existence validation, prompt caching, incremental review across pushes, dismissed-pattern learning, and a webhook + queue server you can run with `docker-compose up`.

## Status

Pre-1.0. Public source under BSL 1.1 (auto-converts to Apache 2.0 on 2030-05-11). See `LICENSE`.

## Quick start

```bash
pnpm install
cp .env.example .env
# fill in OPENROUTER_API_KEY (or set LLM_PROVIDER=ollama for local)
# fill in GITLAB_API_URL / GITLAB_TOKEN
docker compose up -d            # starts Postgres
pnpm db:migrate
pnpm dev
```

Point your GitLab webhook at `http://your-host:3000/webhook` with `WEBHOOK_SECRET`.

## Supported code hosts

- GitLab (production-ready)
- GitHub (roadmap)

## Supported LLM providers

- OpenRouter (Anthropic, MiniMax, DeepSeek, etc.)
- Ollama (local or Cloud)
- Anthropic direct (roadmap)
- OpenAI direct (roadmap)

## Configuration highlights

| Env | Purpose |
|---|---|
| `REVIEW_LANGUAGE` | Output language for findings (default `en`; aliases: `ru`, `de`, `es`, `fr`, `ja`, `ko`, `pt`, `uk`, `zh-cn`, `zh-tw`) |
| `LLM_PROVIDER` | `openrouter` or `ollama` |
| `WORKSPACE_PACKAGE_PREFIXES` | Comma-separated workspace prefixes to skip in doc-context resolution |
| `ARCHITECTURE_SNAPSHOT_ENABLED` | Inject target-repo overview (CLAUDE.md, package.json, src tree) into prompts |
| `SEVERITY_THRESHOLD` | Lowest severity that gets posted inline |

Full list: `.env.example`.

## Architecture

- `src/pipeline/` — pass orchestrator, prompts, tools, codebase doc-context
- `src/review/` — diff parser, anchor validators, suggestion sanitizer, threading
- `src/infrastructure/llm/` — provider adapters (OpenRouter, Ollama)
- `src/infrastructure/code-host/` — GitLab adapter
- `src/application/` — webhook orchestration, snapshots, overlays
- `src/domain/` — ports & types

## Contributing

See `CONTRIBUTING.md`.

## License

Business Source License 1.1, converting to Apache 2.0 on 2030-05-11.
You may use, modify, and self-host this software in production. You may not
offer it as a hosted or managed service whose primary value is the
functionality of this software. For commercial / hosted licensing,
contact the Licensor (see `LICENSE`).