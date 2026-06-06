# @gkosach/core — AI Reviewer

Source-available, self-hostable AI code review pipeline.

Multi-pass review (skip-filter → triage → file-review → cross-file → aggregation), anchor-based grounding so the bot can only post on real diff lines, import-path-existence validation, prompt caching, incremental review across pushes, dismissed-pattern learning, and a webhook + queue server you can run with `docker-compose up`.

## Status

Pre-1.0. Source-available under FSL-1.1-ALv2 (auto-converts to Apache 2.0 two years after each version's release). See `LICENSE.md`.

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

## Production image

A root `Dockerfile` builds a slim multi-stage image (~405MB) running the
webhook + queue server (`node dist/index.js`) with prod-only dependencies:

```bash
docker build -t ai-reviewer .
docker run -p 3000:3000 --env-file .env ai-reviewer
```

Run `pnpm db:migrate` separately against the database before serving (the
runtime image carries no toolchain).

## Supported code hosts

- GitLab (production-ready)
- GitHub (roadmap)

## Supported LLM providers

- OpenRouter (Anthropic, MiniMax, DeepSeek, etc.)
- Ollama (local or Cloud)
- Anthropic direct (roadmap)
- OpenAI direct (roadmap)

## Configuration highlights

| Env                             | Purpose                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_LANGUAGE`               | Output language for findings (default `en`; aliases: `ru`, `de`, `es`, `fr`, `ja`, `ko`, `pt`, `uk`, `zh-cn`, `zh-tw`) |
| `LLM_PROVIDER`                  | `openrouter` or `ollama`                                                                                               |
| `WORKSPACE_PACKAGE_PREFIXES`    | Comma-separated workspace prefixes to skip in doc-context resolution                                                   |
| `ARCHITECTURE_SNAPSHOT_ENABLED` | Inject target-repo overview (CLAUDE.md, package.json, src tree) into prompts                                           |
| `SEVERITY_THRESHOLD`            | Lowest severity that gets posted inline                                                                                |

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

Functional Source License 1.1 (FSL-1.1-ALv2), converting to Apache 2.0 two
years after each version's release. You may use, copy, modify, and self-host
this software for any Permitted Purpose. You may not make it available to others
as a Competing Use — a commercial product or service that substitutes for, or
offers substantially similar functionality to, this software. For commercial /
hosted licensing, contact the Licensor (see `LICENSE.md`).
