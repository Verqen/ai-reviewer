# Contributing

Thanks for considering a contribution. This project is small and opinionated — please read this first.

## Scope

We accept changes that:

- Fix bugs with a regression test
- Add code-host adapters (GitHub, Bitbucket, Gitea)
- Add LLM provider adapters (Anthropic direct, OpenAI direct, vLLM, etc.)
- Improve prompt grounding (rule catalog matching, confidence, anchor handling)
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

This points `core.hooksPath` at `.git-hooks/`: `pre-push` runs the same gates as CI, `commit-msg` checks the message shape.

## Code style and commit messages

Every convention for how code and commits must look, and the check that enforces each one, lives in [`AGENTS.md`](AGENTS.md). It is not repeated here.

## Commit and PR

- One logical change per PR.
- Include test(s) that fail before the change and pass after.
- Title format: the commit message shape from `AGENTS.md`.

## Reporting issues

Please include: code host, LLM provider/model, reproducible diff (or a sanitized snippet), and the pipeline run log if you have it.

## Security

If you find a security issue, do not open a public issue. Email the maintainer (see `LICENSE.md` for contact).

## Licensing of contributions

By submitting a contribution you agree it is licensed under the same FSL-1.1-ALv2 terms (auto-converting to Apache 2.0 two years after each version's release) as the rest of the work.
