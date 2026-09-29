import { describe, expect, it } from "vitest";

import type { ReviewConfigLoader } from "~/application/review-config.loader";
import { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import { PipelineConfig } from "~/config/pipeline.config";
import {
  buildFindingThreadReply,
  buildMentionReply,
} from "~/domain/rule-catalog/thread-reply";
import type { DiffFile } from "~/domain/types/code-host.types";
import type {
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockCommentResolutionService } from "~/test-utils/mock-comment-resolution-service";
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
import { createMockReviewConfigLoader } from "~/test-utils/mock-review-config-loader";
import { createMockReviewHistoryService } from "~/test-utils/mock-review-history-service";

import { ReviewService } from "./review.service";

const MINIMAL_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,3 @@\n context\n+added line\n-removed line\n",
  newPath: "src/index.ts",
  oldPath: "src/index.ts",
};

function createPassWithFindings(
  findings: PassResult["findings"] = [],
): IReviewPass {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>,
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
  findings: PassResult["findings"] = [],
): IReviewPass {
  return {
    execute: (
      _ctx: ReviewContext,
      _prior: Map<string, PassResult>,
    ): Promise<PassResult> =>
      Promise.resolve({
        findings,
        metadata: {
          acceptedFindings: findings,
          postableFindings: findings,
          repostedFindings: [],
          suppressedCount: 0,
        },
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      }),
    name: "aggregation",
  };
}

function createPipelineConfig(threshold = "info"): PipelineConfig {
  const savedThreshold = process.env["SEVERITY_THRESHOLD"];
  process.env["SEVERITY_THRESHOLD"] = threshold;
  const config = new PipelineConfig();
  if (savedThreshold === undefined) {
    delete process.env["SEVERITY_THRESHOLD"];
  } else {
    process.env["SEVERITY_THRESHOLD"] = savedThreshold;
  }
  return config;
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
      undefined,
    ),
    new ReviewRunCompletionService(
      infraRepoPorts,
      codeHost,
      cache,
      logger,
      undefined,
    ),
    passes,
    createMockPipelineMetrics(),
    logger,
  );
}

describe("ReviewService", () => {
  it("delegates to orchestrator.run with triggerType", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
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
      orchestrator,
      pipelineConfig,
      logger,
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(infraRepoPorts.calls.createRun).toHaveLength(1);
    expect(infraRepoPorts.calls.createRun[0]?.triggerType).toBe("mr_open");
    expect(codeHost.calls.getMergeRequestDiff).toHaveLength(1);
    expect(codeHost.calls.getMergeRequestVersions).toHaveLength(1);
  });

  it("does not post inline comments when no findings", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
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
      orchestrator,
      pipelineConfig,
      logger,
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(codeHost.calls.postInlineComment).toHaveLength(0);
    expect(codeHost.calls.postNote).toHaveLength(1);
  });

  it("posts inline comments for findings with valid diff position", async () => {
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
    const infraRepoPorts = createMockInfraRepoPorts();
    const cache = new MemoryCache<boolean>();
    const pipelineConfig = createPipelineConfig("warning");
    const logger = createMockLogger();

    const findings: PassResult["findings"] = [
      {
        category: "correctness",
        comment: "Test finding",
        confidence: 0.9,
        filePath: "src/index.ts",
        lineNumber: 2,
        lineType: "added",
        model: "test",
        passName: "aggregation",
        ruleId: "R-013",
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
      orchestrator,
      pipelineConfig,
      logger,
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(codeHost.calls.postInlineComment.length).toBeGreaterThan(0);
  });

  it("skips review when orchestrator finds completed run (DB dedup)", async () => {
    const completedRun = createMockReviewRun({ status: "completed" });
    const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
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
      orchestrator,
      pipelineConfig,
      logger,
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
      orchestrator,
      pipelineConfig,
      logger,
    );

    await service.reviewMergeRequest(1, 42, "mr_open");

    expect(cache.has("review:1:42:head-sha")).toBe(true);
  });
});

function createPipelineConfigWithCatalogUrl(
  catalogUrl: string | undefined,
): PipelineConfig {
  return new PipelineConfig({
    ...createPipelineConfig("info").envs,
    RULE_CATALOG_URL: catalogUrl,
  });
}

function createReplyServiceUnderTest(catalogUrl: string | undefined): {
  codeHost: ReturnType<typeof createMockCodeHost>;
  service: ReviewService;
} {
  const codeHost = createMockCodeHost({ diffs: [MINIMAL_DIFF] });
  const logger = createMockLogger();
  const pipelineConfig = createPipelineConfigWithCatalogUrl(catalogUrl);
  const orchestrator = createTestOrchestrator({
    cache: new MemoryCache<boolean>(),
    codeHost,
    config: pipelineConfig,
    infraRepoPorts: createMockInfraRepoPorts(),
    logger,
    passes: [createAggregationPass()],
  });
  return {
    codeHost,
    service: new ReviewService(codeHost, orchestrator, pipelineConfig, logger),
  };
}

function buildPendingFindingForThread(
  ruleId: ReviewFinding["ruleId"],
): ReviewFinding {
  return {
    category: "correctness",
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
    ruleId,
    severity: "warning",
  };
}

describe("ReviewService.respondToComment", () => {
  it("replies in the discussion with the fixed mention text", async () => {
    const { codeHost, service } = createReplyServiceUnderTest(
      "https://rules.example.com/rules",
    );

    await service.respondToComment(1, 42, {
      discussionId: "disc-9",
      newLine: 1,
      newPath: "src/index.ts",
      note: "@ai what about this line?",
    });

    expect(codeHost.calls.replyToDiscussion).toEqual([
      [1, 42, "disc-9", buildMentionReply("https://rules.example.com/rules")],
    ]);
    expect(codeHost.calls.postNote).toHaveLength(0);
    expect(codeHost.calls.getMergeRequestDiff).toHaveLength(0);
  });

  it("posts a note with the fixed mention text when the comment has no discussion", async () => {
    const { codeHost, service } = createReplyServiceUnderTest(undefined);

    await service.respondToComment(1, 42, { note: "@ai explain this MR" });

    expect(codeHost.calls.postNote).toEqual([
      [1, 42, buildMentionReply(undefined)],
    ]);
    expect(codeHost.calls.replyToDiscussion).toHaveLength(0);
  });
});

describe("ReviewService.respondToFindingThreadClarification", () => {
  it("returns the fixed rule text for a finding with a catalog rule", async () => {
    const { codeHost, service } = createReplyServiceUnderTest(
      "https://rules.example.com/rules",
    );
    const reply = await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread("R-013"),
    );

    expect(reply).toBe(
      buildFindingThreadReply("R-013", "https://rules.example.com/rules"),
    );
    expect(codeHost.calls.getMergeRequestDiff).toHaveLength(0);
  });

  it("returns an empty reply for a finding without a catalog rule", async () => {
    const { service } = createReplyServiceUnderTest(
      "https://rules.example.com/rules",
    );

    const reply = await service.respondToFindingThreadClarification(
      1,
      42,
      buildPendingFindingForThread(undefined),
    );

    expect(reply).toBe("");
  });
});
