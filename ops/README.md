# AI Reviewer — ops artefacts

## Prometheus

`prometheus.yml` is a minimal scrape-config template for the `/metrics`
endpoint exposed by the ai-reviewer Fastify server (default port `3000`).
Use it as a reference — the real Prometheus config is maintained centrally by
the ops team.

Metrics surfaced at `GET /metrics`:

- `ai_reviewer_files_skipped_total{reason}` — Counter; `reason` ∈ `lock`,
  `translation`, `build`, `snapshot`, `generated`, `binary`
- `ai_reviewer_triage_trivial_total` — Counter; hunks classified as trivial
  and excluded from the expensive review model
- `ai_reviewer_triage_skip_rate` — Gauge `[0..1]`; share of hunks marked
  trivial on the latest run
- `ai_reviewer_tokens_input_total{model, phase}` /
  `ai_reviewer_tokens_output_total{model, phase}` /
  `ai_reviewer_tokens_cached_total{model}` — Counters
- `ai_reviewer_cost_usd_total{model}` — Counter; derived from the local
  pricing table in `src/config/llm-pricing.ts`
- `ai_reviewer_cache_hit_rate{model}` — Gauge
- `ai_reviewer_review_duration_ms{status}` — Histogram
- `ai_reviewer_runs_total{status, trigger_type}` — Counter

## Grafana

Dashboards are managed in a separate ops repository and provisioned
automatically — nothing to commit here.
