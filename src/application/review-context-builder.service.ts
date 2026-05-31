import type { FastifyBaseLogger } from "fastify";

import { buildArchitectureSnapshot } from "~/application/architecture-snapshot";
import { loadOverlayResolutionPathPrefixesFromBaselineSnapshot } from "~/application/load-overlay-resolution-path-prefixes";
import { buildOverlayPathListsFromParsedDiffs } from "~/application/mr-overlay-paths";
import { OverlayViewService } from "~/application/overlay-view.service";
import type { ReviewConfigLoader } from "~/application/review-config.loader";
import type { ReviewHistoryService } from "~/application/review-history.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { LlmConfig } from "~/config/llm.config";
import type { OpenRouterConfig } from "~/config/openrouter.config";
import type { PipelineConfig } from "~/config/pipeline.config";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { VersionInfo } from "~/domain/types/code-host.types";
import {
  ResolvedReviewPipelineConfigSchema,
  type LoadedReviewPipelineConfig,
  type ReviewPipelineConfig,
} from "~/domain/types/config.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ForcePushCorrelationResult } from "~/domain/types/force-push-correlation.types";
import type { ReviewContext } from "~/domain/types/pipeline.types";

type BuildReviewContextParams = {
  contextChangedPaths?: string[] | undefined;
  diffs: ParsedFileDiff[];
  forcePushCorrelation: ForcePushCorrelationResult | undefined;
  isIncremental: boolean;
  mrIid: number;
  projectId: number;
  reviewRunId: string;
  versions: VersionInfo;
};

/**
 * Loads GitLab/MR, repo config, prior findings, optional overlay, and assembles `ReviewContext`.
 */
class ReviewContextBuilderService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    ReviewTokens.ReviewConfigLoader,
    ReviewTokens.ReviewHistoryService,
    InjectionTokens.PipelineConfig,
    InjectionTokens.LlmConfig,
    InjectionTokens.OpenRouterConfig,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly reviewConfigLoader: ReviewConfigLoader,
    private readonly reviewHistoryService: ReviewHistoryService,
    private readonly pipelineConfig: PipelineConfig,
    private readonly llmConfig: LlmConfig,
    private readonly openRouterConfig: OpenRouterConfig,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async build(params: BuildReviewContextParams): Promise<ReviewContext> {
    const {
      contextChangedPaths,
      diffs,
      forcePushCorrelation,
      isIncremental,
      mrIid,
      projectId,
      reviewRunId,
      versions,
    } = params;
    const mrInfo = await this.codeHost.getMergeRequestInfo(projectId, mrIid);
    const [repoConfig, priorFindingsResult, priorFindingsByFile] =
      await Promise.all([
        this.reviewConfigLoader.load(projectId, versions.headSha),
        this.reviewHistoryService.loadPriorFindings(projectId, mrIid),
        this.reviewHistoryService.loadPriorFindingsByFile(projectId, mrIid),
      ]);
    const { severityThreshold } = this.resolveConfig();
    const resolvedReviewModel = this.resolveReviewModel(repoConfig);
    const resolvedTriageModel = this.resolveTriageModel(repoConfig);
    const reviewConfig: ReviewPipelineConfig =
      ResolvedReviewPipelineConfigSchema.parse({
        ...repoConfig,
        models: {
          ...repoConfig.models,
          review: resolvedReviewModel,
          triage: resolvedTriageModel,
        },
        severityThreshold,
      });
    const baseline =
      await this.infraRepoPorts.snapshotRepo.getBaselineState(projectId);
    let overlayView: ReviewContext["overlayView"];
    let architectureSnapshot: string | undefined;
    if (baseline?.status === "ready") {
      const { changedPaths: parsedChanged, deletedPaths } =
        buildOverlayPathListsFromParsedDiffs(diffs);
      const changedPaths =
        contextChangedPaths && contextChangedPaths.length > 0
          ? contextChangedPaths
          : parsedChanged;
      const overlayDeclaredResolutionPrefixes =
        await loadOverlayResolutionPathPrefixesFromBaselineSnapshot({
          baselineCommitSha: baseline.commitSha,
          logger: this.logger,
          mrChangedPaths: changedPaths,
          mrDeletedPaths: deletedPaths,
          projectId,
          snapshotRepo: this.infraRepoPorts.snapshotRepo,
        });
      overlayView = new OverlayViewService(
        this.infraRepoPorts.snapshotRepo,
        this.codeHost,
        projectId,
        baseline.commitSha,
        versions.headSha,
        changedPaths,
        deletedPaths,
        overlayDeclaredResolutionPrefixes,
        {
          maxListFiles: this.pipelineConfig.envs.OVERLAY_MAX_LIST_FILES,
          maxMatchesPerFile:
            this.pipelineConfig.envs.OVERLAY_MAX_MATCHES_PER_FILE,
          maxReadFileChars:
            this.pipelineConfig.envs.OVERLAY_MAX_READ_FILE_CHARS,
          maxReadFileLines:
            this.pipelineConfig.envs.OVERLAY_MAX_READ_FILE_LINES,
          maxSearchResults: this.pipelineConfig.envs.OVERLAY_MAX_SEARCH_RESULTS,
          maxToolResponseChars:
            this.pipelineConfig.envs.OVERLAY_MAX_TOOL_RESPONSE_CHARS,
        },
      );
      if (this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_ENABLED) {
        architectureSnapshot = await buildArchitectureSnapshot({
          commitSha: baseline.commitSha,
          limits: {
            maxFileChars:
              this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS,
            maxListFiles:
              this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES,
            maxTotalChars:
              this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS,
          },
          logger: this.logger,
          projectId,
          snapshotRepo: this.infraRepoPorts.snapshotRepo,
        });
      } else {
        this.logger.info(
          { projectId },
          "Architecture snapshot disabled by config; review proceeds without it",
        );
      }
    } else {
      this.logger.warn(
        { projectId, status: baseline?.status },
        "Baseline not ready; review proceeds without codebase exploration",
      );
    }
    const context: ReviewContext = {
      architectureSnapshot,
      diffs,
      forcePushCorrelation,
      isIncremental,
      mrIid,
      mrInfo,
      overlayView,
      previousFindings: priorFindingsResult.pending,
      priorFindingsByFile,
      projectId,
      reviewConfig,
      reviewRunId,
      toolCallCache: new Map<string, Promise<string>>(),
      versions,
    };
    return context;
  }

  private resolveConfig(): {
    severityThreshold:
      | "critical"
      | "attention"
      | "warning"
      | "info"
      | "nitpick";
  } {
    return {
      severityThreshold: this.pipelineConfig.envs.SEVERITY_THRESHOLD,
    };
  }

  private resolveReviewModel(repoConfig: LoadedReviewPipelineConfig): string {
    if (repoConfig.modelOverrides.review) {
      return repoConfig.models.review;
    }
    if (this.llmConfig.envs.LLM_PROVIDER === "ollama") {
      return this.llmConfig.envs.OLLAMA_MODEL;
    }
    return this.openRouterConfig.envs.OPENROUTER_MODEL;
  }

  private resolveTriageModel(repoConfig: LoadedReviewPipelineConfig): string {
    if (repoConfig.modelOverrides.triage) {
      return repoConfig.models.triage;
    }
    if (this.llmConfig.envs.LLM_PROVIDER === "ollama") {
      return this.llmConfig.envs.OLLAMA_TRIAGE_MODEL;
    }
    return this.openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL;
  }
}

export type { BuildReviewContextParams };
export { ReviewContextBuilderService };
