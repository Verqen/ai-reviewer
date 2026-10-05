import { statSync, writeFileSync } from "node:fs";

import { destination, pino } from "pino";

import { PublicScanConfig } from "~/config/public-scan.config";
import {
  fetchRepository,
  parseRepositoryTarget,
} from "~/infrastructure/archive/public-repository-source";
import type { PublicScanReport } from "~/review/public-repository-scan";
import {
  createPublicScanDependencies,
  exitCodeFor,
  ORDER_RUN_REVIEWABLE_FILE_LIMIT,
  scanRepositoryArchive,
} from "~/review/public-repository-scan";

const USAGE =
  "usage: pnpm run scan:public -- <owner/repo[@ref] | directory | archive.tar.gz> --out <file.json>";

function parseOut(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--out");
  return index === -1 ? undefined : argv[index + 1];
}

function parseTarget(argv: readonly string[]): string | undefined {
  const outIndex = argv.indexOf("--out");
  return argv.find(
    (value, index) =>
      index !== outIndex && index !== outIndex + 1 && !value.startsWith("--"),
  );
}

function localKind(path: string): "directory" | "file" | null {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return null;
  }
}

function countByRule(report: PublicScanReport): string[] {
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    counts.set(finding.rule_id, (counts.get(finding.rule_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, count]) => `  ${ruleId}  ${String(count)}`);
}

function summarize(report: PublicScanReport, out: string): string {
  const sha =
    report.commit_sha === null ? "" : `@${report.commit_sha.slice(0, 7)}`;
  const cost =
    report.cost_usd === null ? "unknown" : `$${report.cost_usd.toFixed(4)}`;
  return [
    `${report.repository}${sha} · ${report.status} · catalog ${report.catalog_version}`,
    `files counted ${String(report.files_counted)} · reviewed ${String(report.files_reviewed)} · skipped ${String(report.files_skipped.length)}`,
    ...countByRule(report),
    `${String(report.findings.length)} findings · ${cost} · ${String(report.duration_ms)} ms`,
    ...(report.error === null ? [] : [`error: ${report.error}`]),
    `report written to ${out}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const out = parseOut(argv);
  const input = parseTarget(argv);
  if (out === undefined || input === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const config = new PublicScanConfig();
  const logger = pino({ level: "warn" }, destination(2));
  const dependencies = createPublicScanDependencies(logger);
  const fetched = await fetchRepository(
    parseRepositoryTarget(input, localKind(input)),
    {
      apiUrl: config.envs.GITHUB_API_URL,
      fetch,
      token: config.envs.GITHUB_TOKEN,
    },
  );
  const report = await scanRepositoryArchive(dependencies, {
    archive: fetched.archive,
    clock: () => new Date(),
    commitSha: fetched.commitSha,
    maxCostUsd: config.envs.PUBLIC_SCAN_MAX_COST_USD,
    maxReviewableFiles: ORDER_RUN_REVIEWABLE_FILE_LIMIT,
    repository: fetched.repository,
  });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`\n${summarize(report, out)}\n\n`);
  return exitCodeFor(report.status);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `\nFatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
