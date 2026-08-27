# CLAUDE.md

**Read `AGENTS.md` in the repository root before writing any code here. It is the single source of truth for conventions in this project.**

This file deliberately does not restate those rules. A rule copied into two files drifts, and then neither copy can be trusted. What follows is an index into `AGENTS.md`, not a summary of it.

## Stack

TypeScript (strict, `@tsconfig/strictest`), Node 24, pnpm, Fastify, Kysely + Postgres, Zod, typed-inject, Vitest, ESLint, Prettier.

## What `AGENTS.md` governs

- **The one idea** — a rule that is not mechanically checked is a suggestion; the table maps every rule to the check that enforces it, and names the two gaps that have no check.
- **Code** — no comments anywhere in `src/` or `scripts/`; no `any` or `as unknown as`; never disable a rule to make a build pass; pino logger, not `console.*`; English only.
- **Architecture** — hexagonal dependency direction, what belongs in `domain/` vs `application/` vs `infrastructure/`, the `static inject` contract.
- **Pipeline** — the severity set, category vocabulary, suggestion threshold, anchor rules, and the rule that a finding failing a gate is dropped and never softened.
- **Tests** — the three tiers and what each may touch.
- **Configuration and secrets** — every env var through the Zod schemas in `src/config/`, and what must never enter the repository or its history.
- **Commits** — single line, `type(scope): description`, no body, no `Co-Authored-By` trailer, no tool signature, no emoji. This overrides your default trailer behaviour.
- **Adding a rule** — state the principle rather than the fix that prompted it.
- **Working agreement** — verify before claiming, report failures with output, do not widen scope.

`CONTRIBUTING.md` covers what a change is allowed to touch and how to submit it.
