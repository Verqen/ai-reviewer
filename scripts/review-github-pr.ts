/**
 * Review a real GitHub pull request end-to-end through the GitHub adapter:
 * fetch the PR diff via the app installation, run the full pipeline (triage →
 * file-review → cross-file → aggregation) with a real LLM, then POST inline
 * review-comment threads + a summary note (with the production-readiness score)
 * onto the PR. This is the GitHub equivalent of `scan`, but it writes to GitHub.
 *
 * Thin CLI wrapper around the public `reviewGitHubPullRequest` entry point.
 *
 * Examples:
 *   pnpm run review:github -- --owner gkosach --repo test-mr --pr 1
 *   pnpm run review:github -- --owner gkosach --repo test-mr --pr 1 --dry-run
 *
 * Flags:
 *   --owner <login>  repo owner (default: gkosach)
 *   --repo <name>    repo name (default: test-mr)
 *   --pr <number>    pull request number (default: 1)
 *   --dry-run        run the review but DO NOT post anything to GitHub
 *
 * Required env (from .env): CODE_HOST_PROVIDER=github + GitHub App credentials,
 * and an LLM provider key (OPENROUTER_API_KEY or Ollama).
 */

import { reviewGitHubPullRequest } from "~/review/github-pr-review";

const argv = process.argv.slice(2);

function parseString(name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx === -1 ? undefined : argv[idx + 1];
}

function parseNumber(name: string): number | undefined {
  const value = parseString(name);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const owner = parseString("--owner") ?? "gkosach";
  const repo = parseString("--repo") ?? "test-mr";
  const prNumber = parseNumber("--pr") ?? 1;
  const dryRun = argv.includes("--dry-run");

  process.stderr.write(
    `\n[GH-REVIEW] ${owner}/${repo}#${String(prNumber)}  ${dryRun ? "DRY-RUN" : "POSTING"}\n`,
  );

  const result = await reviewGitHubPullRequest({
    owner,
    repo,
    pullRequestNumber: prNumber,
    post: !dryRun,
  });

  process.stderr.write(
    `[GH-REVIEW] findings: ${String(result.findings.length)}  score: ${String(result.score)}/100 (${result.grade})  ${dryRun ? "would post" : "posted"}: ${String(result.postedCount)} → https://github.com/${owner}/${repo}/pull/${String(prNumber)}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\n[GH-REVIEW] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
