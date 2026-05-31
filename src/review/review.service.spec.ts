import { describe, expect, it, vi } from "vitest";

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
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { PromptTokenBudgetExceededError } from "~/infrastructure/llm/estimate-prompt-tokens";
import { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { buildReplyCompletionInstruction } from "~/review/reply-completion-instruction";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import {
  createMockInfraRepoPorts,
  createMockReviewRun,
} from "~/test-utils/mock-infra-repo-ports";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import {
  createMockLlmConfig,
  createMockOpenRouterConfig,
} from "~/test-utils/mock-llm-config";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockPipelineMetrics } from "~/test-utils/mock-pipeline-metrics";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import { ReviewService } from "./review.service";

const COMMENT_RESPONSE_FALLBACK_TEXT =
  "Could not generate a reply. Please refine your question and reference a specific code location.";

const MINIMAL_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,3 @@\n context\n+added line\n-removed line\n",
  newPath: "src/index.ts",
  oldPath: "src/index.ts",
};

function createPassWithFindings(
  findings: PassResult["findings"] = []
): IReviewPass {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>
    ): Promise<PassResult> =>
      Promise.resolve({
        findings,
        metadata: {},
        tokenUsage: { completionTokens: 10, promptTokens: 5 },
      }),
    name: "mock-pass",
  };
}

function createAggregationPass(
  findings: PassResult["findings"] = []
): IReviewPass {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>
    ): Promise<PassResult> =>
      Promise.resolve({
        findings,
        metadata: {
          allFindings: findings,
          postableFindings: findings,
          repostedFindings: [],
          suppressedCount: 0,
        },
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      }),
    name: "aggregation",
  };
}

function createPipelineConfig(
  threshold = "info",
  commentResponseMaxToolRounds?: number
): PipelineConfig {
  const savedThreshold = process.env["SEVERITY_THRESHOLD"];
  const savedCommentResponseMaxToolRounds =
    process.env["COMMENT_RESPONSE_MAX_TOOL_ROUNDS"];

  process.env["SEVERITY_THRESHOLD"] = threshold;
  if (commentResponseMaxToolRounds !== undefined) {
    process.env["COMMENT_RESPONSE_MAX_TOOL_ROUNDS"] = String(
      commentResponseMaxToolRounds
    );
  }

  const config = new PipelineConfig();

  if (savedThreshold === undefined) {
    delete process.env["SEVERITY_THRESHOLD"];
  } else {
    process.env["SEVERITY_THRESHOLD"] = savedThreshold;
  }
  if (savedCommentResponseMaxToolRounds === undefined) {
    delete process.env["COMMENT_RESPONSE_MAX_TOOL_ROUNDS"];
  } else {
    process.env["COMMENT_RESPONSE_MAX_TOOL_ROUNDS"] =
      savedCommentResponseMaxToolRounds;
  }

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

type TestOrchestratorOptions = {
  cache: MemoryCache<boolean>;
  codeHost: ReturnType<typeof createMockCodeHost>;
  config: PipelineConfig;
  infraRepoPorts: ReturnType<typeof createMockInfraRepoPorts>;
  logger: ReturnType<typeof createMockLogger>;
  passes: IReviewPass[];
  reviewConfigLoader?: ReviewConfigLoader;
  llmConfig?: ReturnType<typeof createMockLlmConfig>;
};

function createTestOrchestrator(
  options: TestOrchestratorOptions
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
      logger
    ),
    new ReviewFindingPublisherService(
      infraRepoPorts,
      codeHost,
      createMockCommentResolutionService(),
      logger
    ),
    new ReviewRunCompletionService(infraRepoPorts, codeHost, cache, logger),
    passes,
    createMockPipelineMetrics(),
    logger
  );
}

describe("ReviewService", () => {
  it("delegates to orchestrator.run with triggerType", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient();
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createPassWithFindings(), createAggregationPass()],
    });

    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(infraRepoPorts.calls.createRun).toHaveLength(1);
    expect(infraRepoPorts.calls.createRun[0]?.triggerType).toBe("mr_open");
    expect(codeHost.calls.getMergeRequestDiff).toHaveLength(1);
    expect(codeHost.calls.getMergeRequestVersions).toHaveLength(1);
  });

  it("does not post inline comments when no findings", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient();
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("warning");
    const logger = createMockLogger();

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass([])],
    });

    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(codeHost.calls.postInlineComment).toHaveLength(0);
    expect(codeHost.calls.postNote).toHaveLength(1);
  });

  it("posts inline comments for findings with valid diff position", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient();
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("warning");
    const logger = createMockLogger();

    const findings: PassResult["findings"] = [
      {
        category: "bug",
        comment: "Test finding",
        confidence: 0.9,
        filePath: "src/index.ts",
        lineNumber: 2,
        lineType: "added",
        model: "test",
        passName: "aggregation",
        severity: "warning",
      },
    ];

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass(findings)],
    });

    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(codeHost.calls.postInlineComment.length).toBeGreaterThan(0);
  });

  it("skips review when orchestrator finds completed run (DB dedup)", async () => {
    const completedRun = createMockReviewRun({ status: "completed" });
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient();
    const infraRepoPorts = createMockInfraRepoPorts();
    infraRepoPorts.setCompletedRun(completedRun);
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const passExecuted = { called: false };

    const trackingPass: IReviewPass = {
      execute: (): Promise<PassResult> => {
        passExecuted.called = true;
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
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [trackingPass],
    });

    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(passExecuted.called).toBe(false);
    expect(codeHost.calls.postInlineComment).toHaveLength(0);
  });

  it("sets memory cache entry after successful review", async () => {
    const versions = {
      baseSha: "base-sha",
      headSha: "head-sha",
      startSha: "start-sha",
    };
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF], versions });
    const llm = createMockLlmClient();
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();

    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });

    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(cache.has("review:1:42:head-sha")).toBe(true);
  });

  it("loads repo config and injects path rules in respondToComment system prompt", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const commentRule = "Follow REVIEW.md for comment responses";
    const loadReviewConfig = vi.fn().mockResolvedValue(
      createMockReviewConfig({
        pathRules: [{ extraRules: commentRule, path: "**" }],
      })
    );
    const reviewConfigLoader = {
      load: loadReviewConfig,
    } as unknown as ReviewConfigLoader;
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      reviewConfigLoader,
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "What about this line?",
    });
    expect(loadReviewConfig).toHaveBeenCalledWith(1, "head-sha");
    expect(codeHost.calls.getMergeRequestVersions).toHaveLength(1);
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const systemMessage = firstCall?.[0]?.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain(commentRule);
  });

  it("respondToComment skips tools when triage model is in blocklist (gpt-oss)", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const reviewConfigLoader = {
      load: vi.fn().mockResolvedValue(
        createMockReviewConfig({
          modelOverrides: { review: false, triage: true },
          models: {
            premium: null,
            review: "review-model",
            triage: "gpt-oss:120b-cloud",
          },
        })
      ),
    } as unknown as ReviewConfigLoader;
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      reviewConfigLoader,
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "What about this line?",
    });
    expect(llm.calls.chatCompletion).toHaveLength(1);
    expect(llm.calls.chatCompletionWithTools).toHaveLength(0);
    const [messageArgs] = llm.calls.chatCompletion[0] ?? [];
    const userMessage = messageArgs?.find((m) => m.role === "user");
    expect(userMessage?.content).not.toContain("Completion rule");
  });

  it("filters diff to only the comment file when context.newPath is set", async () => {
    const diffs = [
      {
        diff: "@@ -1,1 +1,1 @@\n+line\n",
        newPath: "src/index.ts",
        oldPath: "src/index.ts",
      },
      {
        diff: "@@ -1,1 +1,1 @@\n+other\n",
        newPath: "src/other.ts",
        oldPath: "src/other.ts",
      },
      {
        diff: "@@ -1,1 +1,1 @@\n+third\n",
        newPath: "src/third.ts",
        oldPath: "src/third.ts",
      },
    ];
    const codeHost = createMockCodeHost({ diffs });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "What about this?",
    });
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("src/index.ts");
    expect(userMessage?.content).not.toContain("src/other.ts");
    expect(userMessage?.content).not.toContain("src/third.ts");
  });

  it("uses triage model for respondToComment LLM call", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const triajeModel = "fast-triage-model";
    const loadReviewConfig = vi.fn().mockResolvedValue(
      createMockReviewConfig({
        modelOverrides: { review: false, triage: true },
        models: { premium: null, review: "review-model", triage: triajeModel },
      })
    );
    const reviewConfigLoader = {
      load: loadReviewConfig,
    } as unknown as ReviewConfigLoader;
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      reviewConfigLoader,
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "Fix this?",
    });
    const [firstCall] = llm.calls.chatCompletionWithTools;
    expect(firstCall?.[2]?.model).toBe(triajeModel);
  });

  it("sets maxTokens=2000 and maxPromptTokensHard on respondToComment", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "What about this?",
    });
    const [firstCall] = llm.calls.chatCompletionWithTools;
    expect(firstCall?.[2]?.maxTokens).toBe(2000);
    expect(firstCall?.[2]?.maxPromptTokensHard).toBeGreaterThan(0);
  });

  it("uses COMMENT_RESPONSE_MAX_TOOL_ROUNDS from config for comment prompt and llm options", async () => {
    const expectedMaxToolRounds = 4;
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info", expectedMaxToolRounds);
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "Verify this logic",
    });
    const [firstCall] = llm.calls.chatCompletionWithTools;
    expect(firstCall?.[2]?.maxToolRounds).toBe(expectedMaxToolRounds);
    const systemMessage = firstCall?.[0]?.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain(
      `max ${String(expectedMaxToolRounds)} tool rounds`
    );
  });

  it("appends completion instruction to user message when model supports tools", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "Verify this logic",
    });
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain(buildReplyCompletionInstruction("English"));
  });

  it("posts fallback reply and does not rethrow when LLM throws PromptTokenBudgetExceededError", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "ok" });
    llm.chatCompletionWithTools = () =>
      Promise.reject(new PromptTokenBudgetExceededError(9000, 8000));
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "Very long question with enormous context",
    });
    expect(codeHost.calls.postNote).toHaveLength(1);
    expect(codeHost.calls.postNote[0]?.[2]).toContain("too large to process");
  });

  it("posts fallback text when respondToComment receives null content", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({
      responses: [
        {
          content: null,
          toolCalls: [],
          usage: { completionTokens: 10, promptTokens: 5 },
        },
      ],
    });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToComment(1, 42, {
      newLine: 1,
      newPath: "src/index.ts",
      note: "What about this line?",
    });
    expect(codeHost.calls.postNote).toHaveLength(1);
    expect(codeHost.calls.postNote[0]?.[2]).toBe(
      COMMENT_RESPONSE_FALLBACK_TEXT
    );
  });
});

function buildPendingFindingForThread(): ReviewFinding {
  return {
    category: "best_practice",
    comment: "Bot comment text",
    confidence: 1,
    filePath: MINIMAL_DIFF.newPath,
    hostDiscussionId: "disc-1",
    id: "finding-1",
    lineNumber: 1,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
  };
}

describe("ReviewService.respondToFindingThreadClarification", () => {
  it("uses narrow chatCompletion without MR tools when baseline is not ready", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "narrow-reply" });
    const infraRepoPorts = createMockInfraRepoPorts();
    vi.spyOn(infraRepoPorts.snapshotRepo, "getBaselineState").mockResolvedValue(
      null
    );
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    const actualText = await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread(),
      "explain this"
    );

    expect(actualText).toBe("narrow-reply");
    expect(llm.calls.chatCompletion.length).toBeGreaterThanOrEqual(1);
    expect(llm.calls.chatCompletionWithTools).toHaveLength(0);
    expect(codeHost.calls.getMergeRequestDiff).toHaveLength(0);
  });

  it("uses chatCompletionWithTools when baseline is ready and model supports tools", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "with-tools-reply" });
    const infraRepoPorts = createMockInfraRepoPorts();
    vi.spyOn(infraRepoPorts.snapshotRepo, "getBaselineState").mockResolvedValue(
      {
        commitSha: "baseline-sha",
        errorMessage: null,
        status: "ready",
      }
    );
    vi.spyOn(codeHost, "getFileContent").mockResolvedValue("blob");
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );

    const actualText = await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread(),
      "please verify fix"
    );

    expect(actualText).toBe("with-tools-reply");
    expect(llm.calls.chatCompletionWithTools).toHaveLength(1);
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain(buildReplyCompletionInstruction("English"));
    expect(firstCall?.[2]?.maxPromptTokensHard).toBe(
      pipelineConfig.envs.FINDING_THREAD_PROMPT_HARD_LIMIT
    );
  });

  it("uses COMMENT_RESPONSE_MAX_TOOL_ROUNDS from config for finding-thread prompt and llm options", async () => {
    const expectedMaxToolRounds = 6;
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const llm = createMockLlmClient({ defaultContent: "with-tools-reply" });
    const infraRepoPorts = createMockInfraRepoPorts();
    vi.spyOn(infraRepoPorts.snapshotRepo, "getBaselineState").mockResolvedValue(
      {
        commitSha: "baseline-sha",
        errorMessage: null,
        status: "ready",
      }
    );
    vi.spyOn(codeHost, "getFileContent").mockResolvedValue("blob");
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info", expectedMaxToolRounds);
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      createMockReviewHistoryService(),
      logger
    );
    await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread(),
      "please verify fix"
    );
    const [firstCall] = llm.calls.chatCompletionWithTools;
    expect(firstCall?.[2]?.maxToolRounds).toBe(expectedMaxToolRounds);
    const systemMessage = firstCall?.[0]?.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain(
      `max ${String(expectedMaxToolRounds)} rounds`
    );
  });

  it("includes full MR diff paths and prior findings summary in thread user prompt", async () => {
    const otherDiff: DiffFile = {
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      newPath: "src/other.ts",
      oldPath: "src/other.ts",
    };
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF, otherDiff] });
    const llm = createMockLlmClient({ defaultContent: "reply" });
    const infraRepoPorts = createMockInfraRepoPorts();
    vi.spyOn(infraRepoPorts.snapshotRepo, "getBaselineState").mockResolvedValue(
      {
        commitSha: "baseline-sha",
        errorMessage: null,
        status: "ready",
      }
    );
    vi.spyOn(codeHost, "getFileContent").mockResolvedValue("blob");
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("info");
    const logger = createMockLogger();
    const orchestrator = createTestOrchestrator({
      cache,
      codeHost,
      config: pipelineConfig,
      infraRepoPorts,
      logger,
      passes: [createAggregationPass()],
    });
    const otherFinding: ReviewFinding = {
      ...buildPendingFindingForThread(),
      comment: "Prior finding on other file",
      filePath: "src/other.ts",
      id: "finding-2",
      lineNumber: 5,
    };
    const reviewHistoryService = {
      ...createMockReviewHistoryService(),
      loadPriorFindings: () =>
        Promise.resolve({
          addressed: [],
          dismissed: [],
          pending: [buildPendingFindingForThread(), otherFinding],
        }),
    } as unknown as ReviewHistoryService;
    const service = new ReviewService(
      codeHost,
      llm,
      orchestrator,
      pipelineConfig,
      createMockReviewConfigLoader(),
      createMockLlmConfig(),
      createMockOpenRouterConfig(),
      infraRepoPorts.snapshotRepo,
      reviewHistoryService,
      logger
    );
    await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread(),
      "question"
    );
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("src/other.ts");
    expect(userMessage?.content).toContain("Other findings on this MR");
    expect(userMessage?.content).toContain("Prior finding on other file");
  });
});
