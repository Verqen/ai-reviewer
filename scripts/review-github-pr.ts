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

const USAGE =
  "usage: pnpm run review:github -- --owner <login> --repo <name> --pr <number> [--dry-run]";

async function main(): Promise<void> {
  const owner = parseString("--owner");
  const repo = parseString("--repo");
  const prNumber = parseNumber("--pr");
  const dryRun = argv.includes("--dry-run");

  if (owner === undefined || repo === undefined || prNumber === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

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
