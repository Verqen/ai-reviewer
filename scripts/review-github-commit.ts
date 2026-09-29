import {
  resolveGitHubDefaultBranchHead,
  reviewGitHubCommit,
} from "~/review/github-commit-review";

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

const DEFAULT_MAX_COST_USD = 20;
const DEFAULT_MAX_REVIEWABLE_FILES = 400;

const USAGE =
  "usage: pnpm run review:github:commit -- --owner <login> --repo <name> [--installation <id>] [--sha <commit>] [--max-cost <usd>] [--max-files <n>] [--catalog-url <url>]";

async function main(): Promise<void> {
  const owner = parseString("--owner");
  const repo = parseString("--repo");
  const installationId = parseNumber("--installation");
  const catalogUrl = parseString("--catalog-url");
  const maxCostUsd = parseNumber("--max-cost") ?? DEFAULT_MAX_COST_USD;
  const maxFilesArgument = parseString("--max-files");
  const maxReviewableFiles =
    maxFilesArgument === undefined
      ? DEFAULT_MAX_REVIEWABLE_FILES
      : Number(maxFilesArgument);

  if (
    owner === undefined ||
    repo === undefined ||
    !Number.isInteger(maxReviewableFiles) ||
    maxReviewableFiles < 1
  ) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  const commitSha =
    parseString("--sha") ??
    (await resolveGitHubDefaultBranchHead({ installationId, owner, repo }))
      .headSha;

  process.stderr.write(
    `\n[GH-COMMIT] ${owner}/${repo}@${commitSha}  ceiling $${String(maxCostUsd)}\n`,
  );

  const result = await reviewGitHubCommit({
    catalogUrl,
    commitSha,
    installationId,
    maxCostUsd,
    maxReviewableFiles,
    owner,
    repo,
  });

  process.stderr.write(
    `[GH-COMMIT] files: ${String(result.filesReviewed)}/${String(result.filesTotal)}  findings: ${String(result.findings.length)}  partial: ${String(result.partial)}  catalog: ${result.catalogVersion}  cost: $${result.tokenCostUsd.toFixed(4)} → ${result.checkRunUrl}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\n[GH-COMMIT] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
