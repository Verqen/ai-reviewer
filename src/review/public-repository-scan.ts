import type { FastifyBaseLogger } from "fastify";

import { ORDER_RUN_MODEL } from "~/config/models";
import { RULE_CATALOG_VERSION } from "~/domain/rule-catalog/rule-catalog";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type {
  ArchiveEntry,
  FileTreeEntry,
} from "~/domain/types/code-host.types";
import {
  assertArchiveReviewable,
  CONSENSUS_PASSES,
  CONSENSUS_QUORUM,
  prepareArchiveReview,
  reviewTree,
} from "~/review/github-commit-review";
import type { TreeReviewDependencies } from "~/review/github-commit-review";
import { RepositoryTooLargeError } from "~/review/repository-size";
import type { ProviderPins } from "~/review/reproducible-llm";
import type { ReviewModels } from "~/review/review-pass-run";
import { createReviewLlm } from "~/review/review-pass-run";
import type { SkippedFile } from "~/review/whole-file-diff";
import { buildWholeFileDiffs } from "~/review/whole-file-diff";

const PUBLIC_SCAN_PROJECT_ID = 0;
const LOCAL_SOURCE_REF = "local";
const ORDER_RUN_REVIEWABLE_FILE_LIMIT = 400;

type PublicScanStatus =
  | "completed"
  | "failed"
  | "partial"
  | "repository_too_large";

interface PublicScanDependencies {
  llm: ILlmClient;
  logger: FastifyBaseLogger;
  models: ReviewModels;
  providerPins: ProviderPins | null;
}

interface PublicScanOptions {
  archive: readonly ArchiveEntry[];
  clock: () => Date;
  commitSha: string | null;
  maxCostUsd: number;
  maxReviewableFiles: number;
  repository: string;
}

interface PublicScanReport {
  repository: string;
  commit_sha: string | null;
  catalog_version: string;
  status: PublicScanStatus;
  error: string | null;
  models: ReviewModels;
  consensus: { passes: number; quorum: number };
  max_cost_usd: number;
  max_reviewable_files: number;
  files_counted: number;
  files_reviewed: number;
  files_skipped: SkippedFile[];
  files_not_fully_reviewed: string[];
  started_at: string;
  duration_ms: number;
  cost_usd: number | null;
  passes: {
    pass: number;
    findings: number;
    partial: boolean;
    cost_usd: number;
  }[];
  findings: { rule_id: string; file: string; line: number }[];
}

function createPublicScanDependencies(
  logger: FastifyBaseLogger,
): PublicScanDependencies {
  const reviewLlm = createReviewLlm(logger, undefined);
  const models =
    reviewLlm.providerPins === null
      ? reviewLlm.models
      : { review: ORDER_RUN_MODEL, triage: ORDER_RUN_MODEL };
  return { ...reviewLlm, logger, models };
}

function archiveOverlaySource(
  archive: readonly ArchiveEntry[],
): TreeReviewDependencies["codeHost"] {
  const contents = new Map(archive.map((entry) => [entry.path, entry.content]));
  return {
    getFileContent(_projectId: number, _ref: string, path: string) {
      const content = contents.get(path);
      return content === undefined
        ? Promise.reject(new Error(`File not found: ${path}`))
        : Promise.resolve(content.toString("utf8"));
    },
    getFileTree(): Promise<FileTreeEntry[]> {
      return Promise.resolve(
        archive.map((entry) => ({ path: entry.path, type: "blob" })),
      );
    },
  };
}

function emptyReport(
  options: PublicScanOptions,
  dependencies: PublicScanDependencies,
  startedAt: Date,
): PublicScanReport {
  return {
    catalog_version: RULE_CATALOG_VERSION,
    commit_sha: options.commitSha,
    consensus: { passes: CONSENSUS_PASSES, quorum: CONSENSUS_QUORUM },
    cost_usd: 0,
    duration_ms: 0,
    error: null,
    files_counted: 0,
    files_not_fully_reviewed: [],
    files_reviewed: 0,
    files_skipped: [],
    findings: [],
    max_cost_usd: options.maxCostUsd,
    max_reviewable_files: options.maxReviewableFiles,
    models: dependencies.models,
    passes: [],
    repository: options.repository,
    started_at: startedAt.toISOString(),
    status: "completed",
  };
}

async function scanRepositoryArchive(
  dependencies: PublicScanDependencies,
  options: PublicScanOptions,
): Promise<PublicScanReport> {
  const treeOptions = {
    commitSha: options.commitSha ?? LOCAL_SOURCE_REF,
    maxCostUsd: options.maxCostUsd,
    maxReviewableFiles: options.maxReviewableFiles,
  };
  assertArchiveReviewable(dependencies, treeOptions);
  const startedAt = options.clock();
  const report = emptyReport(options, dependencies, startedAt);
  const finish = (fields: Partial<PublicScanReport>): PublicScanReport => ({
    ...report,
    ...fields,
    duration_ms: options.clock().getTime() - startedAt.getTime(),
  });
  const treeDependencies = {
    ...dependencies,
    codeHost: archiveOverlaySource(options.archive),
  };

  let ready: ReturnType<typeof prepareArchiveReview<TreeReviewDependencies>>;
  try {
    ready = prepareArchiveReview(
      treeDependencies,
      treeOptions,
      options.archive,
    );
  } catch (error) {
    if (!(error instanceof RepositoryTooLargeError)) throw error;
    return finish({
      error: error.message,
      files_counted: error.reviewableFiles,
      files_skipped: buildWholeFileDiffs(options.archive).skippedFiles,
      status: "repository_too_large",
    });
  }

  const counted = {
    files_counted: ready.prepared.reviewablePaths.length,
    files_skipped: ready.prepared.skippedFiles,
  };
  try {
    const { passes, review, unreviewedPaths } = await reviewTree(
      ready.dependencies,
      treeOptions,
      PUBLIC_SCAN_PROJECT_ID,
      ready.prepared,
      ready.archivePaths,
    );
    return finish({
      ...counted,
      cost_usd: review.tokenCostUsd,
      files_not_fully_reviewed: ready.prepared.reviewablePaths.filter((path) =>
        unreviewedPaths.has(path),
      ),
      files_reviewed: review.filesReviewed,
      findings: review.findings.map((finding) => ({
        file: finding.filePath,
        line: finding.line,
        rule_id: finding.ruleId,
      })),
      passes: passes.map((pass) => ({
        cost_usd: pass.tokenCostUsd,
        findings: pass.findings,
        partial: pass.partial,
        pass: pass.pass,
      })),
      status: review.partial ? "partial" : "completed",
    });
  } catch (error) {
    dependencies.logger.error({ err: error }, "Public repository scan failed");
    return finish({
      ...counted,
      cost_usd: null,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
}

function exitCodeFor(status: PublicScanStatus): number {
  if (status === "failed") return 1;
  if (status === "repository_too_large") return 2;
  return 0;
}

export {
  createPublicScanDependencies,
  exitCodeFor,
  ORDER_RUN_REVIEWABLE_FILE_LIMIT,
  scanRepositoryArchive,
};
export type {
  PublicScanDependencies,
  PublicScanOptions,
  PublicScanReport,
  PublicScanStatus,
};
