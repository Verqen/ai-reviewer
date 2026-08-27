import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ReviewConfigLoader } from "~/application/review-config.loader";
import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { PipelineConfig } from "~/config/pipeline.config";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { DiffFile } from "~/domain/types/code-host.types";
import type {
  AggregationResult,
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { DismissedPatternRepository } from "~/infrastructure/database/repositories/dismissed-pattern.repository";
import { ReviewFindingRepository } from "~/infrastructure/database/repositories/review-finding.repository";
import { ReviewRunRepository } from "~/infrastructure/database/repositories/review-run.repository";
import { parseDiff } from "~/review/diff-parser";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockCommentResolutionService } from "~/test-utils/mock-comment-resolution-service";
import {
  createMockLlmConfig,
  createMockOpenRouterConfig,
} from "~/test-utils/mock-llm-config";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockPipelineMetrics } from "~/test-utils/mock-pipeline-metrics";
import { createMockReviewConfigLoader } from "~/test-utils/mock-review-config-loader";
import { createMockReviewHistoryService } from "~/test-utils/mock-review-history-service";
import { createTestDatabase } from "~/test-utils/test-database";
import type { TestDatabase } from "~/test-utils/test-database";

import { PipelineOrchestrator } from "./pipeline.orchestrator";

const MINIMAL_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,3 @@\n context\n+added line\n-removed line\n",
  newPath: "src/index.ts",
  oldPath: "src/index.ts",
};

function createPipelineConfig(): PipelineConfig {
  process.env["SEVERITY_THRESHOLD"] = "info";
  return new PipelineConfig();
}

function createNoOpSnapshotRepo(): ISnapshotRepository {
  return {
    copySnapshotEntries: () => Promise.resolve(0),
    deleteCommit: () => Promise.resolve(),
    deleteOldSnapshotsBefore: () => Promise.resolve(0),
    getBaselineState: () => Promise.resolve(null),
    getFileContent: () => Promise.resolve(null),
    listFiles: () => Promise.resolve([]),
    listPackageRootsFromSnapshot: () =>
      Promise.resolve({
        hasTopLevelSrcTree: false,
        packageRoots: [],
        packageRootsUsingSrc: [],
      }),
    searchContent: () => Promise.resolve([]),
    setBaselineState: () => Promise.resolve(),
    storeBlobs: () => Promise.resolve(),
    storeSnapshot: () => Promise.resolve(),
  };
}

function makeAggPass(findings: Finding[] = []): IReviewPass<AggregationResult> {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>,
    ): Promise<PassResult<AggregationResult>> => {
      const agg: AggregationResult = {
        allFindings: findings,
        postableFindings: findings,
        repostedFindings: [],
        suppressedCount: 0,
      };
      return Promise.resolve({
        findings,
        metadata: agg,
        tokenUsage: { completionTokens: 5, promptTokens: 10 },
      });
    },
    name: "aggregation",
  };
}

type TestOrchestratorOptions = {
  cache: MemoryCache<boolean>;
  codeHost: ReturnType<typeof createMockCodeHost>;
  config: PipelineConfig;
  infraRepoPorts: ReviewInfraRepoPorts;
  logger: ReturnType<typeof createMockLogger>;
  passes: IReviewPass[];
  reviewConfigLoader?: ReviewConfigLoader;
  llmConfig?: ReturnType<typeof createMockLlmConfig>;
};

function createTestOrchestrator(
  options: TestOrchestratorOptions,
): PipelineOrchestrator {
  const {
    cache,
    codeHost,
    config,
    infraRepoPorts,
    llmConfig = createMockLlmConfig(),
    logger,
    passes,
    reviewConfigLoader = createMockReviewConfigLoader(),
  } = options;
  return new PipelineOrchestrator(
    new ReviewRunLifecycleService(infraRepoPorts, logger, config),
    new ReviewContextBuilderService(
      infraRepoPorts,
      codeHost,
      reviewConfigLoader,
      createMockReviewHistoryService(),
      config,
      llmConfig,
      createMockOpenRouterConfig(),
      logger,
    ),
    new ReviewFindingPublisherService(
      infraRepoPorts,
      codeHost,
      createMockCommentResolutionService(),
      logger,
    ),
    new ReviewRunCompletionService(infraRepoPorts, codeHost, cache, logger),
    passes,
    createMockPipelineMetrics(),
    logger,
  );
}

describe("PipelineOrchestrator (integration)", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  beforeEach(async () => {
    await testDb.wipe();
  });

  it("creates review_run and review_finding rows in Postgres", async () => {
    const db = testDb.db;
    const reviewRunRepo = new ReviewRunRepository(db);
    const reviewFindingRepo = new ReviewFindingRepository(db);
    const dismissedPatternRepo = new DismissedPatternRepository(db);

    const infraRepoPorts = {
      dismissedPatternRepo,
      reviewFindingRepo,
      reviewRunRepo,
      snapshotRepo: createNoOpSnapshotRepo(),
    };

    const finding: Finding = {
      category: "bug",
      comment: "Integration test finding",
      confidence: 0.9,
      filePath: "src/index.ts",
      lineNumber: 2,
      lineType: "added",
      model: "test-model",
      passName: "aggregation",
      severity: "warning",
    };

    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [makeAggPass([finding])],
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 1,
      triggerType: "mr_open",
      versions: {
        baseSha: "base-sha",
        headSha: "head-sha",
        startSha: "start-sha",
      },
    });

    const runs = await db
      .selectFrom("review_run")
      .selectAll()
      .where("project_id", "=", 1)
      .where("mr_iid", "=", 1)
      .execute();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");

    const runId = runs[0]!.id;
    const findings = await db
      .selectFrom("review_finding")
      .selectAll()
      .where("review_run_id", "=", runId)
      .execute();

    expect(findings.length).toBeGreaterThan(0);
  });

  it("does not create duplicate run for same 5-tuple", async () => {
    const db = testDb.db;
    const reviewRunRepo = new ReviewRunRepository(db);
    const reviewFindingRepo = new ReviewFindingRepository(db);
    const dismissedPatternRepo = new DismissedPatternRepository(db);

    const infraRepoPorts = {
      dismissedPatternRepo,
      reviewFindingRepo,
      reviewRunRepo,
      snapshotRepo: createNoOpSnapshotRepo(),
    };

    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const versions = {
      baseSha: "base-sha",
      headSha: "head-sha",
      startSha: "start-sha",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [makeAggPass()],
    });

    await orchestrator.run({
      diffs: [],
      mrIid: 1,
      projectId: 1,
      triggerType: "mr_open",
      versions,
    });
    await orchestrator.run({
      diffs: [],
      mrIid: 1,
      projectId: 1,
      triggerType: "mr_open",
      versions,
    });

    const runs = await db
      .selectFrom("review_run")
      .selectAll()
      .where("project_id", "=", 1)
      .where("mr_iid", "=", 1)
      .execute();

    expect(runs).toHaveLength(1);
  });
});
