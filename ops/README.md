# AI Reviewer — ops artefacts

## Prometheus

`prometheus.yml` is a scrape-config for the `/metrics` endpoint exposed by the
Fastify server (default port `3000`). Point a Prometheus instance at it, or
merge the job into an existing configuration.

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

No dashboards are committed here. The metrics above are plain counters,
gauges and one histogram, so any dashboard is a few panels over them.
