# Project rules for AI assistants

This file is consumed by Claude Code (and similar assistants) working inside this repository.

## Stack

TypeScript (strict, `@tsconfig/strictest`), Node 24, pnpm, Fastify, Kysely + Postgres, Zod, typed-inject, Vitest, ESLint, Prettier.

## Hard rules

- No emojis, no unsolicited feedback, no opinions unless asked.
- No deleting files not tracked by git.
- Production code uses the injected pino logger, never `console.*`. Test files are exempt.
- Strict TypeScript: no `any`, no `as unknown as T`, no `@ts-ignore`/`@ts-expect-error`.
- **NO comments in code.** Zero `//`, `/* */`, or JSDoc/docblocks in shipped code (incl. tests). Self-documenting only: clear names, small functions, explicit types. If a cast/decision seems to need a comment, restructure to remove the need — never add the comment. English only.
- Never disable ESLint or TypeScript rules to make a build pass.

## Architecture

- DDD-light with hexagonal boundaries: `src/domain/` defines ports and types, `src/application/` orchestrates use cases, `src/infrastructure/` holds adapters, `src/pipeline/` and `src/review/` hold the review pipeline and per-MR review logic.
- Adapters depend on domain interfaces, never the other way around.
- DI: every class injected via `typed-inject` declares `public static inject = [...] as const` matching constructor parameter order.

## Pipeline conventions

- Findings carry severity from the closed set: `critical | attention | warning | info | nitpick`.
- `category` is a free-form string but should reuse a documented vocabulary so deduplication keys are stable across passes. See prompts under `src/pipeline/prompts/` for the vocab.
- Suggestions are only emitted when confidence >= 0.8 and the fix is unambiguous, and never for `line_type = "removed"`.
- Anchor (`line_number`, `line_type`, `file_path`) must match the allowable-anchors table for that file diff. Findings with mismatched anchors are dropped, not silently posted.

## Tests

- Unit tests: `*.spec.ts`, fully mocked.
- Integration tests: `*.test.ts`, real infra (Postgres via testcontainers).
- E2E tests: `*.e2e.test.ts`, full HTTP cycle.

## Output language

The reviewer's output language is set by `REVIEW_LANGUAGE` (default `en`). Prompt builders accept an explicit `language` argument; tests should pass a value rather than rely on env state.

## Commits

`type(scope): description`, single line. Examples:

- `feat(pipeline): add cross-file pass token budget`
- `fix(gitlab): treat 404 on getFileContent as missing, not crash`
- `refactor(review): extract anchor validation`
