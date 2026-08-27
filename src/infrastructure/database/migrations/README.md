# migrations/

Applied in filename order by `FileMigrationProvider`; `kysely_migration` records what already ran, so every migration runs exactly once.

## Rules

- **Raw SQL, not the query builder.** A migration is an immutable snapshot of intent — the reader must see the statement that runs, pasteable into `psql`.
- **No re-runnability guards.** No `IF NOT EXISTS`, `IF EXISTS`, `OR REPLACE`, `ADD VALUE IF NOT EXISTS`, no `.ifNotExists()`. The tracking table already guarantees single execution; a guard hides a desync instead of fixing it.
- **The database does not fabricate business values.** No `DEFAULT` on a domain column (status, resolution, plan, flags) — the use case that creates the row supplies it. Bookkeeping columns (`id`, `created_at`, `updated_at`, counters) keep their defaults.
- **Never edit an applied migration.** Recover with a new one.

## Documented exception

`20260415020000-remove-analytics.ts` keeps `IF EXISTS` / `IF NOT EXISTS`. It is a cutover migration inherited from the monorepo this engine was extracted from: `review_analytics` was created there, never by this chain, so the table is present in databases carried over from the original deployment and absent in every database created from `20260415000000-initial-schema.ts`. Both states are legitimate at that point in the chain, which is exactly the one-time-bridge case the guard rule carves out. Nothing after it may rely on that table.
