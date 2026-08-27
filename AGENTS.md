# AGENTS.md — conventions for agents working in this repository

This is the single source of truth for how code is written here. It applies to every AI agent (Claude Code, Cursor, Copilot, or anything else) and to human contributors alike. `CLAUDE.md` points here rather than restating anything: one rule lives in exactly one place, or the two copies drift and nobody can tell which one is current.

`CONTRIBUTING.md` covers what a contribution is allowed to change and how to submit it. This file covers how the code itself must look and why.

## The one idea

**A rule that is not mechanically checked is a suggestion, and agents route around suggestions.**

An agent under pressure to make a build pass will find the path of least resistance. The defense is never a more emphatic instruction — it is a check that fails. So every rule below carries the mechanism that enforces it, and where no mechanism exists, that is stated instead of being papered over. An honest "review-only" label tells you where to actually look during review; a rule that pretends to be enforced tells you nothing and costs you attention.

| Rule                                         | Enforced by                                                                                                               | When it runs                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| No comments anywhere in `src/` or `scripts/` | `src/no-code-comments.spec.ts` — parses every `.ts` file with the TypeScript compiler API and reports file, line and text | `test:unit`, pre-push, CI                 |
| No `any`, no unsafe assignment/call/return   | `@tsconfig/strictest` + `typescript-eslint` recommendedTypeChecked                                                        | `types:check`, `lint:check`, pre-push, CI |
| No unused locals or parameters               | `noUnusedLocals`, `noUnusedParameters`, `no-unused-vars` (`_` prefix opts out)                                            | `types:check`, `lint:check`, pre-push, CI |
| No `console.*` in production code            | `no-console` on `src/**` excluding tests                                                                                  | `lint:check`, pre-push, CI                |
| DI wiring matches constructor order          | `typed-inject` types the `inject` tuple against the constructor                                                           | `types:check`, build                      |
| Test tier by filename                        | vitest projects: `*.spec.ts` unit, `*.test.ts` integration, `*.e2e.test.ts` e2e                                           | `test:unit`, `test:integration`, CI       |
| Formatting                                   | Prettier                                                                                                                  | `format:check`, pre-push, CI              |
| Commit message shape                         | `.git-hooks/commit-msg`                                                                                                   | local commit, **opt-in**                  |
| Migration authoring rules                    | review only — no mechanical check                                                                                         | —                                         |
| Anchor, grounding and cap gates on findings  | runtime code paths, covered by unit specs                                                                                 | production, `test:unit`                   |

Two of those lines are honest weak points. The commit hook is local and opt-in (`pnpm run install:gitHooks`), so a clone that skips it is unguarded — and the repository history proves the cost: commits made before the hook existed carry tool trailers the hook now rejects. The migration rules in `src/infrastructure/database/migrations/README.md` are prose a reviewer has to apply by hand. Both are candidates for a CI gate.

One drift worth knowing: the no-`console` rule as written below is absolute, but the linter is configured to allow `console.warn` and `console.error`. Production code currently contains neither, so the stricter rule holds in practice — but the mechanism is weaker than the rule. Do not treat the linter's silence as permission.

## Code

**No comments. None.** Zero `//`, `/* */`, JSDoc or docblocks in anything under `src/` or `scripts/`, tests included. Self-documenting only: precise names, small functions, explicit types. If a cast or a branch feels like it needs a comment, that is a signal to restructure until it does not — extract a named function, introduce a named type, split the branch. Never add the comment.

The reasoning is specific to this repository, not a general style preference. This project's own product reads code and reasons about it. A comment is an unverifiable claim sitting next to code that can change without it; the code is the only thing that stays true. Prose that explains a decision belongs in a `README.md` next to the files it governs — `src/infrastructure/database/migrations/README.md` and `scripts/README.md` are exactly that, and they are where the explanations that used to be comments now live.

**Strict TypeScript.** No `any`, no `as unknown as T`, no `@ts-ignore`, no `@ts-expect-error`. Tests and scripts relax the unsafe-\* rules because a mock is not production code, but they do not relax your judgment.

**Never disable a rule to make a build pass.** Not an ESLint disable comment (which would also be a comment, and therefore already forbidden), not a tsconfig loosening, not a skipped test. A failing check is information. If a rule is genuinely wrong, change the rule deliberately, in its own commit, with the reason in the commit subject.

**Production code logs through the injected pino logger, never `console.*`.** Tests are exempt. A logger the composition root owns can be levelled, structured, redacted and shipped; a `console` call can do none of that and cannot be silenced in a library consumer's process.

**English only in code** — identifiers, strings, log messages, test names.

## Architecture

DDD-light with hexagonal boundaries. The direction of dependency is the rule; everything else follows from it.

- `src/domain/` — ports and types. No infrastructure imports, ever. If something is a business rule, it lives here even when it feels like plumbing: `CostBudget` is in the domain because a spend ceiling is a policy, not a transport detail.
- `src/application/` — use cases. Orchestrates ports, owns no I/O of its own.
- `src/infrastructure/` — adapters. Depends on domain interfaces, never the reverse.
- `src/pipeline/` and `src/review/` — the review pipeline and the per-change review logic.
- `src/di/` — composition root. Every injected class declares `public static inject = [...] as const` matching constructor parameter order.

An adapter importing from `application/`, or a domain file importing from `infrastructure/`, is a defect regardless of whether it compiles. There is no lint rule for this yet; it is on you and on review.

Prefer extending an existing port to inventing a new abstraction. A new port is a real cost: it has to be mocked in every test that touches it and wired in the composition root.

## Pipeline

- Findings carry severity from the closed set `critical | attention | warning | info | nitpick`.
- `category` is a free-form string, but reuse the vocabulary documented in `src/pipeline/prompts/` so deduplication keys stay stable across passes and runs.
- Suggestions are emitted only when confidence is at least 0.8 and the fix is unambiguous, and never for `line_type = "removed"`.
- The anchor (`file_path`, `line_number`, `line_type`) must match the allowable-anchors table for that file's diff.

**A finding that fails a gate is dropped, never softened.** Not downgraded to a lower severity, not rewritten as a question, not posted with a hedge. A hedged wrong comment costs a reviewer the same attention as a confident wrong one and additionally teaches them to distrust the whole run. This is the single most important behavioural rule in the pipeline; if you find yourself adding a fallback that keeps a failed finding alive in some weaker form, you have misread the design.

## Tests

- `*.spec.ts` — unit, fully mocked, no network, no database.
- `*.test.ts` — integration, real infrastructure (Postgres via testcontainers).
- `*.e2e.test.ts` — end-to-end, full HTTP cycle.

Every behaviour change ships with a test that fails before it and passes after. When a branch's only observable outcome is a log line or a metric, assert on that — an untested branch that "obviously works" is the one that silently stops working.

Do not weaken an assertion to make a test pass. Do not delete a failing test to unblock yourself. Report the failure instead.

## Configuration and secrets

Every environment variable is read through the Zod schemas in `src/config/`, never `process.env` at the point of use. A blank value means unset. Adding a variable means: extend the schema, add it to `.env.example` with a comment explaining what absence does, and state the default in the schema.

`.env.example` holds placeholders and public example hosts only. No real hostname, token, key, project ID, internal service name or customer identifier belongs in this repository, in any file, in any commit, at any point in history. That constraint is permanent: a secret committed once and removed later is still a leaked secret, because the object stays reachable in the history.

## Commits

Single line, `type(scope): description`. Types: `chore`, `ci`, `docs`, `feat`, `fix`, `refactor`, `style`, `test`. Scope optional.

No body. No `Co-Authored-By` trailer. No "Generated with" line. No emoji. This overrides the default behaviour of any assistant that adds such trailers automatically — including the one you are probably running right now.

The reason is stated in the hook itself and is worth repeating: history is read a year later to find out who decided what and why. A tool signature answers neither question, and it corrupts `git log --author`, contributor statistics and generated changelogs for as long as the repository exists.

```
feat(pipeline): add cross-file pass token budget
fix(gitlab): treat 404 on getFileContent as missing, not crash
refactor(review): extract anchor validation
```

Install the hooks once per clone: `pnpm run install:gitHooks`.

## Adding a rule to this file

One rule, one place. Before adding anything here:

**State the principle, not the fix that prompted it.** A rule distilled from a change you just wrote inherits that change's blind spot. "A unique-constraint violation is deterministic, therefore permanent" is a principle you can reason from; "propagate it so the caller retries" is one fix's disposition, and if that fix was wrong the rule now enshrines the bug and a reviewer following it will approve the next instance. Write the invariant and the reason; let the disposition follow from it.

**Do not let code you just authored be the sole authority for the rule you write from it.** When the author and the rule-writer are the same person and the code has had no independent review, the rule is unvalidated. Check it against the stated principle and against an existing place in the repository that already solves the same shape.

**Keep examples at principle level.** An example pinned to a specific live file goes stale the moment that file is refactored, and then the canonical convention document contradicts the shipped code.

**Say how it is enforced.** Add the row to the table. If there is no mechanism, write "review only" — do not leave the reader to assume there is a check.

## Working agreement

- Verify before claiming. Read the file, run the check, quote the output. "Should work" is not a result.
- Report failures plainly, with the output. A skipped step gets said out loud.
- Do the task that was asked. Do not widen scope, add a changelog nobody requested, or reformat files you did not otherwise touch.
- When a rule here conflicts with what you were about to do, the rule wins. When a rule here is wrong, say so and argue it — do not silently ignore it.
