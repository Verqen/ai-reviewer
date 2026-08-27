# Contributing

Thanks for considering a contribution. This project is small and opinionated — please read this first.

## Scope

We accept changes that:

- Fix bugs with a regression test
- Add code-host adapters (GitHub, Bitbucket, Gitea)
- Add LLM provider adapters (Anthropic direct, OpenAI direct, vLLM, etc.)
- Improve prompt grounding (severity / category / confidence rubrics, anchor handling, suggestion sanitizing)
- Improve incremental review correctness across rebases / force pushes

We are unlikely to accept:

- Style refactors without behaviour change
- Adding new dependencies "for convenience"
- Features that only make sense in a managed-service deployment (those belong in a commercial fork)
- Translations or i18n machinery beyond `REVIEW_LANGUAGE` (the model handles target language)

## Dev loop

```bash
pnpm install
pnpm types:check
pnpm test:unit
pnpm lint:check
```

Integration tests use testcontainers and need Docker running:

```bash
pnpm test:integration
```

## Enforcement gates

Install the git hooks once per clone:

```bash
pnpm run install:gitHooks
```

This points `core.hooksPath` at `.git-hooks/`. `pre-push` runs format, lint, types, build and the unit tests. `commit-msg` rejects a subject that is not `type(scope): description` (scope optional, type one of `chore`, `ci`, `docs`, `feat`, `fix`, `refactor`, `style`, `test`), any message with more than one non-empty line, and any `Co-Authored-By:` trailer, `Generated with` line or emoji anywhere in the message.

The no-comments rule is enforced by `src/no-code-comments.spec.ts`: it parses every `.ts` file under `src/` and `scripts/` with the TypeScript compiler API and reports the file, line and text of each comment it finds. It lives in the `unit` project, so `pnpm test:unit` and `pre-push` both cover it.

## Code style

- Strict TypeScript (extends `@tsconfig/strictest`). No `any`, no `as unknown as`.
- No comments in code. Zero `//`, `/* */` or JSDoc anywhere under `src/`, `scripts/` or the tests. If something seems to need a comment, restructure it: clearer names, smaller functions, explicit types.
- Self-documenting names. English only in code.
- Production code uses the injected pino logger, not `console.*`.

## Commit and PR

- One logical change per PR.
- Include test(s) that fail before the change and pass after.
- Title format: `type(scope): description` — e.g. `fix(pipeline): drop findings with anchor outside hunk`.

## Reporting issues

Please include: code host, LLM provider/model, reproducible diff (or a sanitized snippet), and the pipeline run log if you have it.

## Security

If you find a security issue, do not open a public issue. Email the maintainer (see `LICENSE.md` for contact).

## Licensing of contributions

By submitting a contribution you agree it is licensed under the same FSL-1.1-ALv2 terms (auto-converting to Apache 2.0 two years after each version's release) as the rest of the work.
