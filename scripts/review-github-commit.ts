import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
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
    `\nChecking ${owner}/${repo} at ${commitSha.slice(0, 7)} against the rule catalog\n\n`,
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

  const rows = result.findings.map((finding) => ({
    finding,
    title: findCatalogRule(finding.ruleId)?.title ?? "",
  }));
  const titleWidth = Math.max(0, ...rows.map((row) => row.title.length));
  for (const { finding, title } of rows) {
    process.stderr.write(
      `  ${finding.severity.padEnd(9)} ${finding.ruleId}  ${title.padEnd(titleWidth)}  ${finding.filePath}:${String(finding.line)}\n`,
    );
  }
  process.stderr.write(
    `\n${String(result.findings.length)} findings · ${String(result.filesReviewed)} of ${String(result.filesTotal)} files · catalog ${result.catalogVersion}${result.partial ? " · partial" : ""} · $${result.tokenCostUsd.toFixed(4)}\n`,
  );
  process.stderr.write(
    `Published as a GitHub Check: ${result.checkRunUrl}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\nFatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
