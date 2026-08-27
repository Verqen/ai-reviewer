import type { FastifyBaseLogger } from "fastify";

import type { ReviewContextBuilderService } from "~/application/review-context-builder.service";
import type { ReviewFindingPublisherService } from "~/application/review-finding-publisher.service";
import type { ReviewRunCompletionService } from "~/application/review-run-completion.service";
import type { ReviewRunLifecycleService } from "~/application/review-run-lifecycle.service";
import { computeCostUsd } from "~/config/llm-pricing";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { VersionInfo } from "~/domain/types/code-host.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ForcePushCorrelationResult } from "~/domain/types/force-push-correlation.types";
import type {
  AggregationResult,
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import {
  isForcePushLikeTriggerType,
  type TriggerType,
} from "~/domain/types/review.types";
import type {
  IPipelineMetrics,
  ReviewPhase,
} from "~/domain/ports/pipeline-metrics.port";
import type { SkipCategory } from "~/domain/types/skip.types";
import { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";
import {
  applyTriageFilter,
  type TriagePassMetadata,
} from "~/pipeline/passes/triage.pass";

export interface PipelineInput {
  contextChangedPaths?: string[] | undefined;
  diffs: ParsedFileDiff[];
  forcePushCorrelation?: ForcePushCorrelationResult | undefined;
  isIncremental?: boolean | undefined;
  mrIid: number;
  previousRunId?: string | undefined;
  projectId: number;
  triggerType: TriggerType;
  versions: VersionInfo;
}

const PASS_NAME_TO_PHASE: Readonly<Record<string, ReviewPhase>> = {
  "cross-file": "cross-file",
  "file-review": "file-review",
  triage: "triage",
};

interface PassModelUsageEntry {
  completionTokens: number;
  costUsd: number;
  model: string;
  promptTokens: number;
}

function resolvePassTokenUsageByModel(
  result: PassResult,
  passName: string,
  models: { review: string; triage: string },
): Record<string, { completionTokens: number; promptTokens: number }> {
  if (result.tokenUsageByModel) {
    return result.tokenUsageByModel;
  }
  if (
    result.tokenUsage.promptTokens === 0 &&
    result.tokenUsage.completionTokens === 0
  ) {
    return {};
  }
  const fallbackModel = passName === "triage" ? models.triage : models.review;
  return { [fallbackModel]: result.tokenUsage };
}

function buildPassModelBreakdown(
  result: PassResult,
  passName: string,
  models: { review: string; triage: string },
): PassModelUsageEntry[] {
  const breakdown = resolvePassTokenUsageByModel(result, passName, models);
  return Object.entries(breakdown).map(([model, usage]) => ({
    completionTokens: usage.completionTokens,
    costUsd: computeCostUsd(model, {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    }),
    model,
    promptTokens: usage.promptTokens,
  }));
}

export class PipelineOrchestrator {
  static inject = [
    ReviewTokens.ReviewRunLifecycleService,
    ReviewTokens.ReviewContextBuilderService,
    ReviewTokens.ReviewFindingPublisherService,
    ReviewTokens.ReviewRunCompletionService,
    ReviewTokens.ReviewPasses,
    InjectionTokens.PipelineMetrics,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly reviewRunLifecycleService: ReviewRunLifecycleService,
    private readonly reviewContextBuilderService: ReviewContextBuilderService,
    private readonly reviewFindingPublisherService: ReviewFindingPublisherService,
    private readonly reviewRunCompletionService: ReviewRunCompletionService,
    private readonly passes: IReviewPass[],
    private readonly metrics: IPipelineMetrics,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async run(input: PipelineInput): Promise<void> {
    const {
      contextChangedPaths,
      diffs,
      forcePushCorrelation,
      isIncremental = false,
      mrIid,
      previousRunId,
      projectId,
      triggerType,
      versions,
    } = input;

    const runStartedAt = Date.now();

    const filteredDiffs: ParsedFileDiff[] = [];
    const skippedByReason: Partial<Record<SkipCategory, number>> = {};
    for (const diff of diffs) {
      const reason = getPrimarySkipReason(diff.newPath);
      if (reason === null) {
        filteredDiffs.push(diff);
        continue;
      }
      this.metrics.observeFileSkipped(reason);
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    }
    const skippedCount = diffs.length - filteredDiffs.length;
    if (skippedCount > 0) {
      this.logger.info(
        {
          mrIid,
          originalCount: diffs.length,
          projectId,
          reviewableCount: filteredDiffs.length,
          skippedByReason,
          skippedCount,
        },
        "Skip-filter applied",
      );
    }

    const startResult = await this.reviewRunLifecycleService.startRun({
      isIncremental,
      mrIid,
      previousRunId,
      projectId,
      triggerType,
      versions,
    });
    if (startResult.outcome === "skipped") {
      this.metrics.observeRunCompletion({
        durationMs: Date.now() - runStartedAt,
        status: "skipped",
        triggerType,
      });
      return;
    }
    const { reviewRun } = startResult;
    try {
      const context = await this.reviewContextBuilderService.build({
        contextChangedPaths,
        diffs: filteredDiffs,
        forcePushCorrelation,
        isIncremental,
        mrIid,
        projectId,
        reviewRunId: reviewRun.id,
        versions,
      });
      const passResults = new Map<string, PassResult>();
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const tokensByModel = new Map<
        string,
        { completionTokens: number; promptTokens: number }
      >();
      let activeContext = context;
      for (const pass of this.passes) {
        const priorFindingsByPass =
          pass.name === "aggregation"
            ? Object.fromEntries(
                [...passResults.entries()].map(([name, pr]) => [
                  name,
                  pr.findings.length,
                ]),
              )
            : undefined;
        this.logger.info(
          {
            diffCount: activeContext.diffs.length,
            mrIid,
            passName: pass.name,
            priorFindingsByPass,
            projectId,
            reviewRunId: reviewRun.id,
          },
          "Pipeline pass starting",
        );
        const passStartedAt = Date.now();
        const result = await pass.execute(activeContext, passResults);
        const durationMs = Date.now() - passStartedAt;
        const passModelBreakdown = buildPassModelBreakdown(
          result,
          pass.name,
          activeContext.reviewConfig.models,
        );
        const passCostUsd = passModelBreakdown.reduce(
          (sum, entry) => sum + entry.costUsd,
          0,
        );
        this.logger.info(
          {
            completionTokens: result.tokenUsage.completionTokens,
            costUsd: passCostUsd,
            durationMs,
            findingsCount: result.findings.length,
            mrIid,
            passName: pass.name,
            projectId,
            promptTokens: result.tokenUsage.promptTokens,
            reviewRunId: reviewRun.id,
            tokensByModel: passModelBreakdown,
            triggerType,
          },
          "Pipeline pass completed",
        );
        passResults.set(pass.name, result);
        totalPromptTokens += result.tokenUsage.promptTokens;
        totalCompletionTokens += result.tokenUsage.completionTokens;
        const passUsageByModel = resolvePassTokenUsageByModel(
          result,
          pass.name,
          activeContext.reviewConfig.models,
        );
        for (const [modelName, usage] of Object.entries(passUsageByModel)) {
          const existing = tokensByModel.get(modelName) ?? {
            completionTokens: 0,
            promptTokens: 0,
          };
          tokensByModel.set(modelName, {
            completionTokens:
              existing.completionTokens + usage.completionTokens,
            promptTokens: existing.promptTokens + usage.promptTokens,
          });
        }
        this.observePassMetrics(pass.name, result, activeContext);
        if (pass.name === "triage") {
          activeContext = this.applyTriageToContext(activeContext, result);
        }
      }
      const aggregationResult = passResults.get("aggregation")?.metadata as
        | AggregationResult
        | undefined;
      const postableFindings =
        aggregationResult?.postableFindings ??
        passResults.get("file-review")?.findings ??
        [];
      const allFindings = aggregationResult?.allFindings ?? postableFindings;
      const repostedFindings = aggregationResult?.repostedFindings ?? [];
      const suppressedCount = aggregationResult?.suppressedCount ?? 0;
      await this.reviewFindingPublisherService.publishInlineFindingsAndStore({
        allFindings,
        diffs: filteredDiffs,
        mrIid,
        postableFindings,
        projectId,
        reviewRunId: reviewRun.id,
        versions,
      });
      if (isForcePushLikeTriggerType(triggerType) && forcePushCorrelation) {
        await this.reviewFindingPublisherService.repostCorrelatedFindings({
          correlated: forcePushCorrelation.correlated,
          mrIid,
          projectId,
          reviewRunId: reviewRun.id,
          versions,
        });
      }
      await this.reviewFindingPublisherService.resolveStaleIncrementalFindings({
        diffs: filteredDiffs,
        isIncremental,
        mrIid,
        previousRunId,
        projectId,
        triggerType,
      });
      const triageMetaForCompletion = passResults.get("triage")?.metadata as
        | Partial<TriagePassMetadata>
        | undefined;
      const triageParseFailures = triageMetaForCompletion?.parseFailures ?? 0;
      const triageTotalBatches = triageMetaForCompletion?.totalBatches ?? 0;
      const triageDegradation =
        triageTotalBatches > 0 && triageParseFailures > 0
          ? {
              model: context.reviewConfig.models.triage,
              parseFailures: triageParseFailures,
              totalBatches: triageTotalBatches,
            }
          : undefined;
      await this.reviewRunCompletionService.completeSuccessfulRun({
        allFindings,
        baseSha: versions.baseSha,
        diffsFileCount: filteredDiffs.length,
        headSha: versions.headSha,
        mrIid,
        postableFindings,
        projectId,
        repostedFindings,
        reviewConfig: context.reviewConfig,
        reviewRunId: reviewRun.id,
        suppressedCount,
        tokenUsageByModel: Object.fromEntries(tokensByModel),
        totalCompletionTokens,
        totalPromptTokens,
        triageDegradation,
      });
      this.metrics.observeRunCompletion({
        durationMs: Date.now() - runStartedAt,
        status: "completed",
        triggerType,
      });
    } catch (err) {
      this.metrics.observeRunCompletion({
        durationMs: Date.now() - runStartedAt,
        status: "failed",
        triggerType,
      });
      await this.reviewRunLifecycleService.markRunFailed(reviewRun.id, err);
      throw err;
    }
  }

  private observePassMetrics(
    passName: string,
    result: PassResult,
    context: ReviewContext,
  ): void {
    const phase = PASS_NAME_TO_PHASE[passName];
    if (!phase) {
      return;
    }
    const { tokenUsage } = result;
    if (tokenUsage.promptTokens === 0 && tokenUsage.completionTokens === 0) {
      return;
    }
    const model =
      phase === "triage"
        ? context.reviewConfig.models.triage
        : context.reviewConfig.models.review;
    this.metrics.observeLlmCall({
      inputTokens: tokenUsage.promptTokens,
      model,
      outputTokens: tokenUsage.completionTokens,
      phase,
    });
  }

  private applyTriageToContext(
    context: ReviewContext,
    result: PassResult,
  ): ReviewContext {
    const metadata = result.metadata as Partial<TriagePassMetadata>;
    const triageSkipRate = metadata.triageSkipRate ?? 0;
    const trivialHunkCount = metadata.trivialHunkCount ?? 0;
    this.metrics.observeTriageSkipRate(triageSkipRate);
    this.metrics.observeTriageTrivial(trivialHunkCount);
    const trivialKeys = metadata.trivialKeys;
    if (!trivialKeys || trivialKeys.size === 0) {
      return context;
    }
    const filteredDiffs = applyTriageFilter(context.diffs, trivialKeys);
    const droppedFiles = context.diffs.length - filteredDiffs.length;
    this.logger.info(
      {
        droppedFiles,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
        triageSkipRate,
        trivialHunks: trivialKeys.size,
      },
      "Triage filter applied",
    );
    return { ...context, diffs: filteredDiffs };
  }
}
