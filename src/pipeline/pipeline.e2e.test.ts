import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ReviewConfigLoader } from "~/application/review-config.loader";
import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { GitLabConfig } from "~/config/gitlab.config";
import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import { PipelineConfig } from "~/config/pipeline.config";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { IReviewPass } from "~/domain/types/pipeline.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { GitLabCodeHost } from "~/infrastructure/code-host/gitlab/gitlab.code-host";
import { DismissedPatternRepository } from "~/infrastructure/database/repositories/dismissed-pattern.repository";
import { ReviewFindingRepository } from "~/infrastructure/database/repositories/review-finding.repository";
import { ReviewRunRepository } from "~/infrastructure/database/repositories/review-run.repository";
import { AggregationPass } from "~/pipeline/passes/aggregation.pass";
import { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
import { FileReviewPass } from "~/pipeline/passes/file-review.pass";
import { parseDiff } from "~/review/diff-parser";
import { createFakeGitLabServer } from "~/test-utils/fake-gitlab-server";
import { createMockCommentResolutionService } from "~/test-utils/mock-comment-resolution-service";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockPipelineMetrics } from "~/test-utils/mock-pipeline-metrics";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";
import { createMockReviewConfigLoader } from "~/test-utils/mock-review-config-loader";
import { createMockReviewHistoryService } from "~/test-utils/mock-review-history-service";
import { createTestDatabase } from "~/test-utils/test-database";
import type { TestDatabase } from "~/test-utils/test-database";

import { PipelineOrchestrator } from "./pipeline.orchestrator";

function createSerialFileReviewConfigLoader(): ReviewConfigLoader {
  return createMockReviewConfigLoader({
    load: () =>
      Promise.resolve(
        createMockReviewConfig({
          concurrency: { maxParallelFiles: 1 },
        }),
      ),
  });
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

function createE2eOrchestrator(options: {
  cache: MemoryCache<boolean>;
  codeHost: ICodeHost;
  infraRepoPorts: ReviewInfraRepoPorts;
  llmConfig: LlmConfig;
  logger: ReturnType<typeof createMockLogger>;
  openRouterConfig: OpenRouterConfig;
  pipelineConfig: PipelineConfig;
  passes: IReviewPass[];
  reviewConfigLoader?: ReviewConfigLoader;
}): PipelineOrchestrator {
  const {
    cache,
    codeHost,
    infraRepoPorts,
    llmConfig,
    logger,
    openRouterConfig,
    passes,
    pipelineConfig,
    reviewConfigLoader,
  } = options;
  const resolvedReviewConfigLoader =
    reviewConfigLoader ?? createMockReviewConfigLoader();
  return new PipelineOrchestrator(
    new ReviewRunLifecycleService(infraRepoPorts, logger, pipelineConfig),
    new ReviewContextBuilderService(
      infraRepoPorts,
      codeHost,
      resolvedReviewConfigLoader,
      createMockReviewHistoryService(),
      pipelineConfig,
      llmConfig,
      openRouterConfig,
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

const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "gpt-oss:20b-cloud";

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function requireOllama(): Promise<void> {
  if (await isOllamaAvailable()) return;

  throw new Error(
    `This E2E suite needs a reachable Ollama at ${OLLAMA_URL} serving ${OLLAMA_MODEL}. Start it, then rerun pnpm test:e2e.`,
  );
}

describe("PipelineOrchestrator E2E (Ollama + fake GitLab + real Postgres)", () => {
  let testDb: TestDatabase;
  let gitlabServer: ReturnType<typeof createFakeGitLabServer>;
  let gitlabUrl: string;

  beforeAll(async () => {
    await requireOllama();
    testDb = await createTestDatabase();
    gitlabServer = createFakeGitLabServer();
    gitlabUrl = await gitlabServer.start();
  });

  afterAll(async () => {
    await testDb?.cleanup();
    await gitlabServer?.stop();
  });

  beforeEach(async () => {
    await testDb.wipe();
    gitlabServer.reset();
  });

  it("runs full 4-pass pipeline on fixture diff and posts inline comments", async () => {
    const db = testDb.db;
    const logger = createMockLogger();

    process.env["SEVERITY_THRESHOLD"] = "info";
    process.env["GITLAB_API_URL"] = gitlabUrl.replace(/\/$/, "");
    process.env["GITLAB_TOKEN"] = "test-token";
    process.env["LLM_PROVIDER"] = "ollama";
    process.env["OLLAMA_BASE_URL"] = OLLAMA_URL;
    process.env["OLLAMA_MODEL"] = OLLAMA_MODEL;
    process.env["OPENROUTER_API_KEY"] = "e2e-not-used";
    process.env["OPENROUTER_MODEL"] = "e2e-not-used";

    const pipelineConfig = new PipelineConfig();
    const llmConfig = new LlmConfig();
    const openRouterConfig = new OpenRouterConfig();
    const gitlabConfig = new GitLabConfig();
    const reviewRunRepo = new ReviewRunRepository(db);
    const reviewFindingRepo = new ReviewFindingRepository(db);
    const dismissedPatternRepo = new DismissedPatternRepository(db);
    const infraRepoPorts = {
      dismissedPatternRepo,
      reviewFindingRepo,
      reviewRunRepo,
      snapshotRepo: createNoOpSnapshotRepo(),
    };

    const codeHost = new GitLabCodeHost(gitlabConfig, logger);

    const mrDiffs = await codeHost.getMergeRequestDiff(1, 1);
    const parsedDiffs = mrDiffs.map(parseDiff);

    const fileReviewResponses = parsedDiffs.flatMap((diff) => [
      {
        content: `## Analysis ${diff.newPath}\nTest risk.`,
        toolCalls: [],
        usage: { completionTokens: 10, promptTokens: 10 },
      },
      {
        content: JSON.stringify({
          findings: [
            {
              category: "bug",
              comment: `Review finding for ${diff.newPath}`,
              confidence: 0.9,
              file_path: diff.newPath,
              line_number:
                diff.lines.find((line) => line.newLine)?.newLine ?? 1,
              line_type: "added",
              severity: "warning",
            },
          ],
        }),
        toolCalls: [],
        usage: { completionTokens: 10, promptTokens: 10 },
      },
    ]);
    const llm = createMockLlmClient({
      responses: [
        ...fileReviewResponses,
        {
          content: JSON.stringify({ findings: [] }),
          toolCalls: [],
          usage: { completionTokens: 10, promptTokens: 10 },
        },
      ],
    });

    const passes = [
      new FileReviewPass(llm, logger),
      new CrossFilePass(llm, logger),
      new AggregationPass(
        dismissedPatternRepo,
        logger,
        pipelineConfig.envs.LINE_SHIFT_DEDUP_TOLERANCE,
      ),
    ];

    const versions = await codeHost.getMergeRequestVersions(1, 1);
    const cache = new MemoryCache<boolean>();
    const orchestrator = createE2eOrchestrator({
      cache,
      codeHost,
      infraRepoPorts,
      llmConfig,
      logger,
      openRouterConfig,
      passes,
      pipelineConfig,
      reviewConfigLoader: createSerialFileReviewConfigLoader(),
    });

    await orchestrator.run({
      diffs: parsedDiffs,
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
    expect(runs[0]?.status).toBe("completed");

    const notes = gitlabServer.getPostedNotes();
    expect(notes.length).toBeGreaterThan(0);
  });
});
