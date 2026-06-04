import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";

import type { CommentResolutionService } from "~/application/comment-resolution.service";
import type { ReviewConfigLoader } from "~/application/review-config.loader";
import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import type { ReviewHistoryService } from "~/application/review-history.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import { PipelineConfig } from "~/config/pipeline.config";
import type { DiffFile } from "~/domain/types/code-host.types";
import type {
  AggregationResult,
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";
import { hunkKey } from "~/pipeline/passes/triage.pass";
import { parseDiff } from "~/review/diff-parser";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import {
  createMockInfraRepoPorts,
  createMockReviewRun,
} from "~/test-utils/mock-infra-repo-ports";
import {
  createMockLlmConfig,
  createMockOpenRouterConfig,
} from "~/test-utils/mock-llm-config";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockPipelineMetrics } from "~/test-utils/mock-pipeline-metrics";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import { PipelineOrchestrator } from "./pipeline.orchestrator";

const MINIMAL_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,3 @@\n context\n+added line\n-removed line\n",
  newPath: "src/index.ts",
  oldPath: "src/index.ts",
};

function createPipelineConfig(threshold = "info"): PipelineConfig {
  const savedThreshold = process.env["SEVERITY_THRESHOLD"];

  process.env["SEVERITY_THRESHOLD"] = threshold;

  const config = new PipelineConfig();

  if (savedThreshold === undefined) delete process.env["SEVERITY_THRESHOLD"];
  else process.env["SEVERITY_THRESHOLD"] = savedThreshold;

  return config;
}

function createMockReviewConfigLoader(): ReviewConfigLoader {
  return {
    load: () => Promise.resolve(createMockReviewConfig()),
  } as unknown as ReviewConfigLoader;
}

function createMockReviewHistoryService(): ReviewHistoryService {
  return {
    getPendingFindings: () => Promise.resolve([]),
    loadPriorFindings: () =>
      Promise.resolve({ addressed: [], dismissed: [], pending: [] }),
    loadPriorFindingsByFile: () =>
      Promise.resolve({
        addressed: new Map(),
        dismissed: new Map(),
        pending: new Map(),
      }),
  } as unknown as ReviewHistoryService;
}

function createMockCommentResolutionService(): CommentResolutionService {
  return {
    resolveStaleFindings: () => Promise.resolve({ addressed: [], pending: [] }),
  } as unknown as CommentResolutionService;
}

function makeAggPass(findings: Finding[] = []): IReviewPass {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>,
    ): Promise<PassResult> => {
      const agg: AggregationResult = {
        allFindings: findings,
        postableFindings: findings,
        repostedFindings: [],
        suppressedCount: 0,
      };
      return Promise.resolve({
        findings,
        metadata: agg as unknown as Record<string, unknown>,
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      });
    },
    name: "aggregation",
  };
}

type TestOrchestratorOptions = {
  cache: MemoryCache<boolean>;
  codeHost: ReturnType<typeof createMockCodeHost>;
  config: PipelineConfig;
  infraRepoPorts: ReturnType<typeof createMockInfraRepoPorts>;
  logger: ReturnType<typeof createMockLogger>;
  metrics?: PipelineMetrics;
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
    metrics = createMockPipelineMetrics(),
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
    metrics,
    logger,
  );
}

describe("PipelineOrchestrator", () => {
  afterEach(() => {
    delete process.env["SHOW_REVIEW_COST_FOOTER"];
  });

  it("creates review_run and transitions to completed", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
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
      passes: [makeAggPass()],
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(infraRepoPorts.calls.createRun).toHaveLength(1);
    const statusCalls = infraRepoPorts.calls.updateStatus;
    expect(statusCalls.some(([, s]) => s === "in_progress")).toBe(true);
    expect(infraRepoPorts.calls.completeRun).toHaveLength(1);
  });

  it("logs Pipeline pass completed with triggerType, model breakdown and costUsd", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const infoCalls: Array<unknown[]> = [];
    (logger as unknown as { info: (...args: unknown[]) => void }).info = (
      ...args: unknown[]
    ): void => {
      infoCalls.push(args);
    };

    const passes: IReviewPass[] = [
      {
        execute: (): Promise<PassResult> =>
          Promise.resolve({
            findings: [],
            metadata: {},
            tokenUsage: { completionTokens: 100, promptTokens: 1000 },
            tokenUsageByModel: {
              "anthropic/claude-sonnet-4.6": {
                completionTokens: 100,
                promptTokens: 1000,
              },
            },
          }),
        name: "file-review",
      },
      makeAggPass(),
    ];

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes,
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "force_push",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    const fileReviewCompletedLog = infoCalls.find(
      (call) =>
        call[1] === "Pipeline pass completed" &&
        (call[0] as { passName?: string }).passName === "file-review",
    );
    expect(fileReviewCompletedLog).toBeDefined();
    const payload = fileReviewCompletedLog?.[0] as {
      costUsd: number;
      tokensByModel: Array<{ costUsd: number; model: string }>;
      triggerType: string;
    };
    expect(payload.triggerType).toBe("force_push");
    expect(payload.tokensByModel).toHaveLength(1);
    expect(payload.tokensByModel[0]?.model).toBe("anthropic/claude-sonnet-4.6");
    expect(payload.costUsd).toBeGreaterThan(0);
  });

  it("aggregates tokens for every pass that consumed tokens, including passes that omit tokenUsageByModel", async () => {
    process.env["SHOW_REVIEW_COST_FOOTER"] = "true";
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const passes: IReviewPass[] = [
      {
        execute: (): Promise<PassResult> =>
          Promise.resolve({
            findings: [],
            metadata: {},
            tokenUsage: { completionTokens: 200, promptTokens: 1000 },
            tokenUsageByModel: {
              "review-model": { completionTokens: 200, promptTokens: 1000 },
            },
          }),
        name: "file-review",
      },
      {
        execute: (): Promise<PassResult> =>
          Promise.resolve({
            findings: [],
            metadata: {},
            tokenUsage: { completionTokens: 50, promptTokens: 400 },
          }),
        name: "cross-file",
      },
      makeAggPass(),
    ];

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes,
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    const summaryNoteCall = codeHost.calls.postNote.at(-1);
    expect(summaryNoteCall).toBeDefined();
    const summaryText = summaryNoteCall?.[2] ?? "";
    expect(summaryText).toContain("1,000 in / 200 out");
    expect(summaryText).toContain("400 in / 50 out");
  });

  it("runs all passes sequentially", async () => {
    const order: string[] = [];
    const passes: IReviewPass[] = ["file-review", "aggregation"].map(
      (name) => ({
        execute: (): Promise<PassResult> => {
          order.push(name);
          const result: PassResult = {
            findings: [],
            metadata:
              name === "aggregation"
                ? {
                    allFindings: [],
                    postableFindings: [],
                    repostedFindings: [],
                    suppressedCount: 0,
                  }
                : {},
            tokenUsage: { completionTokens: 0, promptTokens: 0 },
          };
          return Promise.resolve(result);
        },
        name,
      }),
    );

    const infraRepoPorts = createMockInfraRepoPorts();
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
      passes,
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(order).toEqual(["file-review", "aggregation"]);
  });

  it("forwards contextChangedPaths to overlay context without changing reviewed diffs", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    infraRepoPorts.snapshotRepo.getBaselineState = () =>
      Promise.resolve({
        commitSha: "base-sha",
        errorMessage: null,
        status: "ready",
      });
    infraRepoPorts.snapshotRepo.listFiles = () => Promise.resolve([]);
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const captured = {
      overlayFiles: "",
      reviewedPaths: [] as string[],
    };
    const capturePass: IReviewPass = {
      execute: async (ctx: ReviewContext): Promise<PassResult> => {
        captured.reviewedPaths = ctx.diffs.map((d) => d.newPath);
        if (!ctx.overlayView) {
          captured.overlayFiles = "";
        } else {
          const executeTool = ctx.overlayView.createToolExecutor();
          captured.overlayFiles = await executeTool({
            arguments: { pattern: "src/**/*.ts" },
            id: "list-files-context-changed-paths",
            name: "list_files",
          });
        }
        return {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        };
      },
      name: "file-review",
    };
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [capturePass, makeAggPass()],
    });
    await orchestrator.run({
      contextChangedPaths: ["src/user/user.router.ts"],
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(captured.reviewedPaths).toEqual(["src/index.ts"]);
    expect(captured.overlayFiles).toContain("src/user/user.router.ts");
  });

  it("skips when existing completed run found (DB dedup)", async () => {
    const completed = createMockReviewRun({ status: "completed" });
    const infraRepoPorts = createMockInfraRepoPorts();
    infraRepoPorts.setCompletedRun(completed);
    const codeHost = createMockCodeHost();
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    let passExecuted = false;
    const trackingPass: IReviewPass = {
      execute: (): Promise<PassResult> => {
        passExecuted = true;
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "tracking",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [trackingPass],
    });

    await orchestrator.run({
      diffs: [],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(passExecuted).toBe(false);
    expect(infraRepoPorts.calls.createRun).toHaveLength(0);
  });

  it("sets status to failed and stores error when pass throws", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const failingPass: IReviewPass = {
      execute: (): Promise<PassResult> =>
        Promise.reject(new Error("Pass exploded")),
      name: "failing",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [failingPass],
    });

    await expect(
      orchestrator.run({
        diffs: [parseDiff(MINIMAL_DIFF)],
        mrIid: 1,
        projectId: 42,
        triggerType: "mr_open",
        versions: { baseSha: "base", headSha: "head", startSha: "start" },
      }),
    ).rejects.toThrow("Pass exploded");

    const statusCalls = infraRepoPorts.calls.updateStatus;
    expect(statusCalls.some(([, s]) => s === "failed")).toBe(true);

    const statsCalls = infraRepoPorts.calls.updateStats;
    expect(
      statsCalls.some(([, stats]) => stats.errorMessage === "Pass exploded"),
    ).toBe(true);
  });

  it("sets cache entry after successful review", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
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
      passes: [makeAggPass()],
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 5,
      projectId: 10,
      triggerType: "mr_open",
      versions: {
        baseSha: "base-sha",
        headSha: "head-sha",
        startSha: "start-sha",
      },
    });

    expect(cache.has("review:10:5:head-sha")).toBe(true);
  });

  it("posts inline comments for postable findings", async () => {
    const finding: Finding = {
      category: "bug",
      comment: "Test finding",
      confidence: 0.9,
      filePath: "src/index.ts",
      lineNumber: 2,
      lineType: "added",
      model: "test",
      passName: "aggregation",
      severity: "warning",
    };

    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig("info");
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
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(codeHost.calls.postInlineComment.length).toBeGreaterThan(0);
  });

  it("uses OLLAMA_MODEL when review model is not explicit", async () => {
    let actualModel: string | null = null;
    const capturePass: IReviewPass = {
      execute: (context: ReviewContext): Promise<PassResult> => {
        actualModel = context.reviewConfig.models.review;
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "capture-model",
    };
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      llmConfig: createMockLlmConfig({
        ollamaModel: "qwen3:14b",
        provider: "ollama",
      }),
      logger,
      passes: [capturePass],
    });
    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 1,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(actualModel).toBe("qwen3:14b");
  });

  it("keeps explicit review model override for ollama provider", async () => {
    let actualModel: string | null = null;
    const capturePass: IReviewPass = {
      execute: (context: ReviewContext): Promise<PassResult> => {
        actualModel = context.reviewConfig.models.review;
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "capture-model",
    };
    const configLoader: ReviewConfigLoader = {
      load: () =>
        Promise.resolve(
          createMockReviewConfig({
            modelOverrides: { review: true, triage: false },
            models: {
              premium: null,
              review: "anthropic/claude-sonnet-4.6",
              triage: "minimax/minimax-m2.7",
            },
          }),
        ),
    } as unknown as ReviewConfigLoader;
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      llmConfig: createMockLlmConfig({
        ollamaModel: "qwen3:14b",
        provider: "ollama",
      }),
      logger,
      passes: [capturePass],
      reviewConfigLoader: configLoader,
    });
    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 1,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(actualModel).toBe("anthropic/claude-sonnet-4.6");
  });

  it("removes lock files and locales via skip-filter and reports reason-labelled metrics", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const registry = new Registry();
    const metrics = new PipelineMetrics(registry);

    const captured: { paths: string[] } = { paths: [] };
    const capturePass: IReviewPass = {
      execute: (ctx): Promise<PassResult> => {
        captured.paths = ctx.diffs.map((d) => d.newPath);
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "file-review",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      metrics,
      passes: [capturePass, makeAggPass()],
    });

    await orchestrator.run({
      diffs: [
        parseDiff(MINIMAL_DIFF),
        parseDiff({
          diff: "@@ -1,1 +1,1 @@\n-a\n+b\n",
          newPath: "pnpm-lock.yaml",
          oldPath: "pnpm-lock.yaml",
        }),
        parseDiff({
          diff: "@@ -1,1 +1,1 @@\n-x\n+y\n",
          newPath: "src/locales/ru.po",
          oldPath: "src/locales/ru.po",
        }),
      ],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(captured.paths).toEqual(["src/index.ts"]);
    const output = await registry.metrics();
    expect(output).toMatch(
      /ai_reviewer_files_skipped_total\{reason="lock"\} 1/,
    );
    expect(output).toMatch(
      /ai_reviewer_files_skipped_total\{reason="translation"\} 1/,
    );
  });

  it("runs cross-file pass even when file-review consumed many tokens", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    let crossFileExecuted = false;

    const fileReviewPass: IReviewPass = {
      execute: (): Promise<PassResult> =>
        Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 5_000, promptTokens: 30_000 },
        }),
      name: "file-review",
    };

    const crossFilePass: IReviewPass = {
      execute: (): Promise<PassResult> => {
        crossFileExecuted = true;
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 100, promptTokens: 1_000 },
        });
      },
      name: "cross-file",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [fileReviewPass, crossFilePass, makeAggPass()],
    });

    await orchestrator.run({
      diffs: [parseDiff(MINIMAL_DIFF)],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(crossFileExecuted).toBe(true);
  });

  it("applies triage verdicts so downstream passes only see needs-review hunks", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const triagePass: IReviewPass = {
      execute: (ctx): Promise<PassResult> => {
        const trivialKeys = new Set<string>();
        for (const diff of ctx.diffs) {
          if (diff.newPath === "src/trivial.ts") {
            for (const line of diff.lines) {
              trivialKeys.add(hunkKey(diff.newPath, line.hunkHeader));
            }
          }
        }
        return Promise.resolve({
          findings: [],
          metadata: {
            decisions: [],
            triageSkipRate: 0.5,
            trivialHunkCount: trivialKeys.size,
            trivialKeys,
          },
          tokenUsage: { completionTokens: 1, promptTokens: 1 },
        });
      },
      name: "triage",
    };

    const captured: { paths: string[] } = { paths: [] };
    const capturePass: IReviewPass = {
      execute: (ctx): Promise<PassResult> => {
        captured.paths = ctx.diffs.map((d) => d.newPath);
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "file-review",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [triagePass, capturePass, makeAggPass()],
    });

    await orchestrator.run({
      diffs: [
        parseDiff({
          diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
          newPath: "src/trivial.ts",
          oldPath: "src/trivial.ts",
        }),
        parseDiff(MINIMAL_DIFF),
      ],
      mrIid: 1,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(captured.paths).toEqual(["src/index.ts"]);
  });
  it("keeps new file and non-trivial new hunk for file-review after triage on force-push", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();
    const existingHeaderTrivial = "@@ -1,1 +1,1 @@";
    const existingHeaderNeedsReview = "@@ -40,1 +40,2 @@";
    const triagePass: IReviewPass = {
      execute: (): Promise<PassResult> =>
        Promise.resolve({
          findings: [],
          metadata: {
            decisions: [
              {
                filePath: "src/existing.ts",
                hunkHeader: existingHeaderTrivial,
                verdict: "trivial",
              },
              {
                filePath: "src/existing.ts",
                hunkHeader: existingHeaderNeedsReview,
                verdict: "needs-review",
              },
              {
                filePath: "src/new-file.ts",
                hunkHeader: "@@ -0,0 +1,2 @@",
                verdict: "needs-review",
              },
            ],
            triageSkipRate: 0.33,
            trivialHunkCount: 1,
            trivialKeys: new Set<string>([
              hunkKey("src/existing.ts", existingHeaderTrivial),
            ]),
          },
          tokenUsage: { completionTokens: 1, promptTokens: 1 },
        }),
      name: "triage",
    };
    const captured: {
      linesByPath: Map<string, string[]>;
      paths: string[];
    } = {
      linesByPath: new Map<string, string[]>(),
      paths: [],
    };
    const fileReviewCapturePass: IReviewPass = {
      execute: (ctx): Promise<PassResult> => {
        captured.paths = ctx.diffs.map((d) => d.newPath);
        captured.linesByPath = new Map(
          ctx.diffs.map((d) => [
            d.newPath,
            d.lines.map((line) => line.content),
          ]),
        );
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "file-review",
    };
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [triagePass, fileReviewCapturePass, makeAggPass()],
    });
    await orchestrator.run({
      diffs: [
        parseDiff({
          diff: `${existingHeaderTrivial}\n-old import\n+old import updated\n${existingHeaderNeedsReview}\n old body\n+new risky change\n`,
          newPath: "src/existing.ts",
          oldPath: "src/existing.ts",
        }),
        parseDiff({
          diff: "@@ -0,0 +1,2 @@\n+export const created = true;\n+export const value = 1;\n",
          newPath: "src/new-file.ts",
          oldPath: "src/new-file.ts",
        }),
      ],
      isIncremental: true,
      mrIid: 1,
      projectId: 42,
      triggerType: "force_push",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(captured.paths.sort()).toEqual(
      ["src/existing.ts", "src/new-file.ts"].sort(),
    );
    expect(captured.linesByPath.get("src/existing.ts")).toContain(
      "new risky change",
    );
    expect(captured.linesByPath.get("src/existing.ts")).not.toContain(
      "old import updated",
    );
    expect(captured.linesByPath.get("src/new-file.ts")).toContain(
      "export const created = true;",
    );
  });

  it("keeps overflow hunks for file-review when triage metadata is capped", async () => {
    const infraRepoPorts = createMockInfraRepoPorts();
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const cache = new MemoryCache<boolean>();
    const config = createPipelineConfig();
    const logger = createMockLogger();

    const headerOne = "@@ -1,1 +1,1 @@";
    const headerTwo = "@@ -10,1 +10,1 @@";
    const headerThree = "@@ -20,1 +20,1 @@";
    const headerFour = "@@ -30,1 +30,1 @@";
    const headerFive = "@@ -40,1 +40,1 @@";

    const triagePass: IReviewPass = {
      execute: (_ctx): Promise<PassResult> => {
        const trivialKeys = new Set<string>([
          hunkKey("src/mixed.ts", headerOne),
          hunkKey("src/mixed.ts", headerTwo),
        ]);
        return Promise.resolve({
          findings: [],
          metadata: {
            decisions: [
              {
                filePath: "src/mixed.ts",
                hunkHeader: headerOne,
                verdict: "trivial",
              },
              {
                filePath: "src/mixed.ts",
                hunkHeader: headerTwo,
                verdict: "trivial",
              },
              {
                filePath: "src/mixed.ts",
                hunkHeader: headerThree,
                verdict: "needs-review",
              },
              {
                filePath: "src/mixed.ts",
                hunkHeader: headerFour,
                verdict: "needs-review",
              },
              {
                filePath: "src/mixed.ts",
                hunkHeader: headerFive,
                verdict: "needs-review",
              },
            ],
            triageSkipRate: 0.4,
            trivialHunkCount: trivialKeys.size,
            trivialKeys,
          },
          tokenUsage: { completionTokens: 1, promptTokens: 1 },
        });
      },
      name: "triage",
    };

    const captured: { headersByPath: Map<string, string[]>; paths: string[] } =
      {
        headersByPath: new Map<string, string[]>(),
        paths: [],
      };
    const capturePass: IReviewPass = {
      execute: (ctx): Promise<PassResult> => {
        captured.paths = ctx.diffs.map((d) => d.newPath);
        captured.headersByPath = new Map(
          ctx.diffs.map((diff) => [
            diff.newPath,
            [...new Set(diff.lines.map((line) => line.hunkHeader))],
          ]),
        );
        return Promise.resolve({
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        });
      },
      name: "file-review",
    };

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config,
      infraRepoPorts,
      logger,
      passes: [triagePass, capturePass, makeAggPass()],
    });

    await orchestrator.run({
      diffs: [
        parseDiff({
          diff: `${headerOne}\n-old1\n+new1\n${headerTwo}\n-old2\n+new2\n${headerThree}\n-old3\n+new3\n${headerFour}\n-old4\n+new4\n${headerFive}\n-old5\n+new5\n`,
          newPath: "src/mixed.ts",
          oldPath: "src/mixed.ts",
        }),
        parseDiff(MINIMAL_DIFF),
      ],
      mrIid: 2,
      projectId: 42,
      triggerType: "mr_open",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(captured.paths).toEqual(["src/mixed.ts", "src/index.ts"]);
    expect(captured.headersByPath.get("src/mixed.ts")).toEqual([
      headerThree,
      headerFour,
      headerFive,
    ]);
  });
});
