import type { FastifyBaseLogger } from "fastify";

import { buildArchitectureSnapshot } from "~/application/architecture-snapshot";
import { loadOverlayResolutionPathPrefixesFromBaselineSnapshot } from "~/application/load-overlay-resolution-path-prefixes";
import { buildOverlayPathListsFromParsedDiffs } from "~/application/mr-overlay-paths";
import { OverlayViewService } from "~/application/overlay-view.service";
import type { ReviewConfigLoader } from "~/application/review-config.loader";
import type { ReviewHistoryService } from "~/application/review-history.service";
import { computeCostUsd } from "~/config/llm-pricing";
import type { LlmConfig } from "~/config/llm.config";
import type { OpenRouterConfig } from "~/config/openrouter.config";
import type { PipelineConfig } from "~/config/pipeline.config";
import { InfraPortsTokens } from "~/di/infra-ports-tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import { resolveDefaultLlmModel } from "~/config/resolve-default-llm-model";
import { CostBudget } from "~/domain/cost-budget";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { DiffFile, VersionInfo } from "~/domain/types/code-host.types";
import type { LlmResponse, ToolCall } from "~/domain/types/llm.types";
import type {
  CommentContext,
  ReviewFinding,
  TriggerType,
} from "~/domain/types/review.types";
import { PromptTokenBudgetExceededError } from "~/infrastructure/llm/estimate-prompt-tokens";
import type { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { resolveProjectAndPathRulesText } from "~/pipeline/prompts/resolve-path-rules";
import { codebaseTools, diffHunkTool } from "~/pipeline/tools/codebase-tools";
import {
  executeDiffHunkTool,
  normalizeComparableRepoPath,
} from "~/pipeline/tools/execute-diff-hunk-tool";
import type { ParsedFileDiff } from "~/review/diff-parser";
import { formatParsedDiffForPrompt, parseDiff } from "~/review/diff-parser";
import { buildThreadPriorFindingsSummary } from "~/review/prior-findings-thread-summary";
import { getReviewLanguage } from "~/config/review-language";
import { buildReplyCompletionInstruction } from "~/review/reply-completion-instruction";
import { runNarrowFindingClarification } from "~/review/review-narrow-finding-clarification";
import {
  buildFindingThreadClarificationSystemPrompt,
  buildFindingThreadClarificationUserPrompt,
} from "~/review/review-thread-clarification.prompt";
import { buildCommentSystemPrompt } from "~/review/review.prompt";
import type { IReviewService } from "~/review/review.types";

const COMMENT_RESPONSE_FALLBACK_TEXT =
  "Could not generate a reply. Please refine your question and reference a specific code location.";
const COMMENT_RESPONSE_FALLBACK_DIFF_CHARS = 20_000;
const COMMENT_RESPONSE_BUDGET_EXCEEDED_REPLY =
  "The context of your question is too large to process. Please refine the question and point to a specific file or line.";
const COMMENT_RESPONSE_COST_CEILING_REPLY =
  "Could not generate a reply: the configured cost ceiling for this operation has been reached.";
const COMMENT_ASSISTANT_REPLY_MAX_TOKENS = 2000;

const FINDING_THREAD_CLARIFICATION_BASELINE_UNAVAILABLE_LOG =
  "Finding thread clarification: baseline not ready or overlay unavailable; narrow-only reply";

const MODELS_WITHOUT_TOOLS = ["gpt-oss"];

class ReviewService implements IReviewService {
  static inject = [
    InjectionTokens.CodeHost,
    InjectionTokens.Llm,
    ReviewTokens.PipelineOrchestrator,
    InjectionTokens.PipelineConfig,
    ReviewTokens.ReviewConfigLoader,
    InjectionTokens.LlmConfig,
    InjectionTokens.OpenRouterConfig,
    InfraPortsTokens.SnapshotRepo,
    ReviewTokens.ReviewHistoryService,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly codeHost: ICodeHost,
    private readonly llm: ILlmClient,
    private readonly orchestrator: PipelineOrchestrator,
    private readonly pipelineConfig: PipelineConfig,
    private readonly reviewConfigLoader: ReviewConfigLoader,
    private readonly llmConfig: LlmConfig,
    private readonly openRouterConfig: OpenRouterConfig,
    private readonly snapshotRepo: ISnapshotRepository,
    private readonly reviewHistoryService: ReviewHistoryService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  private resolveTriageModelForReply(
    repoConfig: Awaited<ReturnType<ReviewConfigLoader["load"]>>,
  ): string {
    if (
      repoConfig.modelOverrides?.triage &&
      repoConfig.models.triage !== null
    ) {
      return repoConfig.models.triage;
    }
    if (this.llmConfig.envs.LLM_PROVIDER === "ollama") {
      return this.llmConfig.envs.OLLAMA_TRIAGE_MODEL;
    }
    return this.openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL;
  }

  private createOperationCostBudget(): CostBudget {
    return new CostBudget(this.pipelineConfig.envs.REVIEW_MAX_COST_USD);
  }

  private recordReplyCost(
    costBudget: CostBudget,
    model: string,
    usage: LlmResponse["usage"],
  ): void {
    costBudget.record(
      computeCostUsd(model, {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      }),
    );
  }

  private canUseToolsForReply(model: string): boolean {
    return !MODELS_WITHOUT_TOOLS.some((blocked) => model.includes(blocked));
  }

  private async buildMrOverlayView(
    projectId: number,
    versions: VersionInfo,
    changedPaths: string[],
    deletedPaths: string[],
  ): Promise<IOverlayView | undefined> {
    const baseline = await this.snapshotRepo.getBaselineState(projectId);
    if (baseline?.status !== "ready") return undefined;

    const overlayDeclaredResolutionPrefixes =
      await loadOverlayResolutionPathPrefixesFromBaselineSnapshot({
        baselineCommitSha: baseline.commitSha,
        logger: this.logger,
        mrChangedPaths: changedPaths,
        mrDeletedPaths: deletedPaths,
        projectId,
        snapshotRepo: this.snapshotRepo,
      });
    const overlay = new OverlayViewService(
      this.snapshotRepo,
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
        maxReadFileChars: this.pipelineConfig.envs.OVERLAY_MAX_READ_FILE_CHARS,
        maxReadFileLines: this.pipelineConfig.envs.OVERLAY_MAX_READ_FILE_LINES,
        maxSearchResults: this.pipelineConfig.envs.OVERLAY_MAX_SEARCH_RESULTS,
        maxToolResponseChars:
          this.pipelineConfig.envs.OVERLAY_MAX_TOOL_RESPONSE_CHARS,
      },
    );
    return overlay;
  }

  private async composeAssistantCommentReply(params: {
    costBudget: CostBudget;
    maxPromptTokensHard?: number | undefined;
    maxTokens?: number | undefined;
    maxToolRounds: number;
    mrIid: number;
    mrParsedDiffs: ParsedFileDiff[];
    overlayChangedPaths: string[];
    overlayDeletedPaths?: string[] | undefined;
    overlayViewPreset?: IOverlayView | undefined;
    projectId: number;
    replyModel: string;
    systemPrompt: string;
    userPrompt: string;
    versions: VersionInfo;
  }): Promise<string> {
    const {
      costBudget,
      maxPromptTokensHard,
      maxTokens = COMMENT_ASSISTANT_REPLY_MAX_TOKENS,
      maxToolRounds,
      mrIid,
      mrParsedDiffs,
      overlayChangedPaths,
      overlayDeletedPaths,
      overlayViewPreset,
      projectId,
      replyModel,
      systemPrompt,
      userPrompt,
      versions,
    } = params;
    const toolsAvailable = this.canUseToolsForReply(replyModel);
    if (costBudget.isExhausted()) {
      this.logger.warn(
        {
          limitUsd: costBudget.limit,
          mrIid,
          projectId,
          spentUsd: costBudget.spent,
        },
        "Cost ceiling reached: skipping assistant comment reply",
      );
      return COMMENT_RESPONSE_COST_CEILING_REPLY;
    }
    try {
      let content: string | null = null;
      if (toolsAvailable) {
        const mrOverlayResolved =
          overlayViewPreset ??
          (await this.buildMrOverlayView(
            projectId,
            versions,
            overlayChangedPaths,
            overlayDeletedPaths ?? [],
          ));
        const builtinDelegate = mrOverlayResolved?.createToolExecutor();
        const mrDiffByComparableNewPath = new Map<string, ParsedFileDiff>();
        for (const mrFileDiff of mrParsedDiffs) {
          mrDiffByComparableNewPath.set(
            normalizeComparableRepoPath(mrFileDiff.newPath),
            mrFileDiff,
          );
        }
        const toolModels =
          builtinDelegate !== undefined
            ? mrParsedDiffs.length > 0
              ? [...codebaseTools, diffHunkTool]
              : [...codebaseTools]
            : [];
        let routingToolExecutor: (call: ToolCall) => Promise<string>;
        if (builtinDelegate === undefined) {
          routingToolExecutor = (): Promise<string> =>
            Promise.resolve("Tool not available");
        } else if (
          mrParsedDiffs.length > 0 &&
          mrOverlayResolved !== undefined
        ) {
          routingToolExecutor = async (call: ToolCall): Promise<string> => {
            if (call.name === "diff_hunk") {
              const pathCandidate = call.arguments["path"];
              if (
                typeof pathCandidate !== "string" ||
                pathCandidate.trim().length === 0
              ) {
                return 'Invalid arguments for diff_hunk: Field "path" must be a non-empty string.';
              }
              const pathKey = normalizeComparableRepoPath(pathCandidate);
              const mrSlice = mrDiffByComparableNewPath.get(pathKey);
              if (mrSlice === undefined) {
                return `diff_hunk: no MR diff matched path ${pathCandidate}.`;
              }
              return executeDiffHunkTool({
                call,
                maxToolChars:
                  this.pipelineConfig.envs.OVERLAY_MAX_TOOL_RESPONSE_CHARS,
                overlay: mrOverlayResolved,
                parsed: mrSlice,
              });
            }
            return builtinDelegate(call);
          };
        } else {
          routingToolExecutor = builtinDelegate;
        }
        const response = await this.llm.chatCompletionWithTools(
          [
            { content: systemPrompt, role: "system" },
            { content: userPrompt, role: "user" },
          ],
          toolModels,
          routingToolExecutor,
          {
            maxPromptTokensHard:
              maxPromptTokensHard ??
              this.pipelineConfig.envs.COMMENT_RESPONSE_PROMPT_HARD_LIMIT,
            maxTokens,
            maxToolRounds,
            model: replyModel,
          },
        );
        this.recordReplyCost(costBudget, replyModel, response.usage);
        content = response.content;
      } else {
        const response = await this.llm.chatCompletion(
          [
            { content: systemPrompt, role: "system" },
            { content: userPrompt, role: "user" },
          ],
          {
            maxPromptTokensHard:
              maxPromptTokensHard ??
              this.pipelineConfig.envs.COMMENT_RESPONSE_PROMPT_HARD_LIMIT,
            maxTokens,
            model: replyModel,
          },
        );
        this.recordReplyCost(costBudget, replyModel, response.usage);
        content = response.content;
      }
      if (content === null) {
        this.logger.warn(
          { mrIid, projectId, toolsAvailable },
          "LLM returned null content for comment response; using fallback text",
        );
      }
      return content ?? COMMENT_RESPONSE_FALLBACK_TEXT;
    } catch (err) {
      if (err instanceof PromptTokenBudgetExceededError) {
        this.logger.warn(
          {
            estimatedTokens: err.estimatedTokens,
            hardLimit: err.hardLimit,
            mrIid,
            projectId,
          },
          "Comment response skipped: prompt token hard limit exceeded",
        );
        return COMMENT_RESPONSE_BUDGET_EXCEEDED_REPLY;
      }
      throw err;
    }
  }

  async respondToComment(
    projectId: number,
    mrIid: number,
    context: CommentContext,
    costBudget: CostBudget = this.createOperationCostBudget(),
  ): Promise<void> {
    this.logger.info({ mrIid, projectId }, "Responding to @ai comment");

    const [mrInfo, diffs, versions] = await Promise.all([
      this.codeHost.getMergeRequestInfo(projectId, mrIid),
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);

    const repoConfig = await this.reviewConfigLoader.load(
      projectId,
      versions.headSha,
    );
    const { pathRules: pathRulesText, projectRules: projectRulesText } =
      resolveProjectAndPathRulesText({
        filePaths: diffs.map((d) => d.newPath),
        pathRules: repoConfig.pathRules ?? [],
      });

    const focusedDiffs = context.newPath
      ? diffs.filter(
          (d) => d.newPath === context.newPath || d.oldPath === context.newPath,
        )
      : diffs;
    const diffsForPrompt =
      focusedDiffs.length > 0 ? focusedDiffs : diffs.slice();
    const { diffText } = this.prepareDiffs(
      diffsForPrompt,
      focusedDiffs.length === 0
        ? COMMENT_RESPONSE_FALLBACK_DIFF_CHARS
        : undefined,
    );

    const threadNotes = context.discussionId
      ? await this.codeHost.getDiscussionNotes(
          projectId,
          mrIid,
          context.discussionId,
        )
      : [];

    const positionLines: string[] = [];

    if (context.newPath) {
      positionLines.push(`File: ${context.newPath}`);
    }

    if (context.newLine) {
      positionLines.push(`Line: ${context.newLine}`);
    } else if (context.oldLine) {
      positionLines.push(`Line (removed): ${context.oldLine}`);
    }

    const commentSection =
      threadNotes.length > 1
        ? `Discussion thread:\n${threadNotes.map((n) => `@${n.author}: ${n.body}`).join("\n\n")}`
        : `Developer comment:\n${context.note}`;

    const userPrompt = [
      `MR: ${mrInfo.title}`,
      `Branch: ${mrInfo.sourceBranch} -> ${mrInfo.targetBranch}`,
      mrInfo.description ? `Description: ${mrInfo.description}` : "",
      "",
      "Diff:",
      diffText,
      "",
      positionLines.length > 0
        ? `Comment location:\n${positionLines.join("\n")}`
        : "",
      "",
      commentSection,
    ]
      .filter(Boolean)
      .join("\n");

    const { parsedDiffs: overlayParsedDiffs } = this.prepareDiffs(diffs);
    const overlayPathLists =
      buildOverlayPathListsFromParsedDiffs(overlayParsedDiffs);

    const replyModel = this.resolveTriageModelForReply(repoConfig);
    const toolsAvailable = this.canUseToolsForReply(replyModel);
    const maxToolRounds =
      this.pipelineConfig.envs.COMMENT_RESPONSE_MAX_TOOL_ROUNDS;
    const systemPrompt = buildCommentSystemPrompt(
      projectRulesText,
      pathRulesText,
      { maxToolRounds, toolsAvailable },
    );

    const userPromptForModel = toolsAvailable
      ? `${userPrompt}\n\n${buildReplyCompletionInstruction(getReviewLanguage())}`
      : userPrompt;

    const responseText = await this.composeAssistantCommentReply({
      costBudget,
      maxTokens: COMMENT_ASSISTANT_REPLY_MAX_TOKENS,
      maxToolRounds,
      mrIid,
      mrParsedDiffs: overlayParsedDiffs,
      overlayChangedPaths: overlayPathLists.changedPaths,
      overlayDeletedPaths: overlayPathLists.deletedPaths,
      projectId,
      replyModel,
      systemPrompt,
      userPrompt: userPromptForModel,
      versions,
    });

    if (context.discussionId) {
      await this.codeHost.replyToDiscussion(
        projectId,
        mrIid,
        context.discussionId,
        responseText,
      );
    } else {
      await this.codeHost.postNote(projectId, mrIid, responseText);
    }

    this.logger.info({ mrIid, projectId }, "Response to @ai comment posted");
  }

  async respondToFindingThreadClarification(
    projectId: number,
    mrIid: number,
    finding: ReviewFinding,
    developerNote: string,
    costBudget: CostBudget = this.createOperationCostBudget(),
  ): Promise<string> {
    this.logger.info(
      { findingId: finding.id, mrIid, projectId },
      "Finding thread clarification: loading MR context",
    );

    const baselineState = await this.snapshotRepo.getBaselineState(projectId);

    if (baselineState?.status !== "ready") {
      this.logger.info(
        { mrIid, projectId },
        FINDING_THREAD_CLARIFICATION_BASELINE_UNAVAILABLE_LOG,
      );
      return runNarrowFindingClarification({
        costBudget,
        costModel: resolveDefaultLlmModel(
          this.llmConfig,
          this.openRouterConfig,
        ),
        developerNote,
        finding,
        llm: this.llm,
        logger: this.logger,
      });
    }

    const [mrInfo, diffs, versions] = await Promise.all([
      this.codeHost.getMergeRequestInfo(projectId, mrIid),
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);

    const repoConfig = await this.reviewConfigLoader.load(
      projectId,
      versions.headSha,
    );

    const { pathRules: pathRulesText, projectRules: projectRulesText } =
      resolveProjectAndPathRulesText({
        filePaths: diffs.map((d) => d.newPath),
        pathRules: repoConfig.pathRules ?? [],
      });

    const { diffText, parsedDiffs } = this.prepareDiffs(diffs);
    const overlayPathLists = buildOverlayPathListsFromParsedDiffs(parsedDiffs);
    const priorFindings = await this.reviewHistoryService.loadPriorFindings(
      projectId,
      mrIid,
    );
    const priorFindingsSummary = buildThreadPriorFindingsSummary(
      priorFindings,
      finding.id,
      this.pipelineConfig.envs.THREAD_PRIOR_FINDINGS_MAX_CHARS,
    );
    let architectureSnapshot: string | undefined;
    if (this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_ENABLED) {
      architectureSnapshot = await buildArchitectureSnapshot({
        commitSha: baselineState.commitSha,
        limits: {
          maxFileChars:
            this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS,
          maxListFiles:
            this.pipelineConfig.envs.ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES,
          maxTotalChars:
            this.pipelineConfig.envs
              .FINDING_THREAD_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS,
        },
        logger: this.logger,
        projectId,
        snapshotRepo: this.snapshotRepo,
      });
    }

    const discussionForThread = finding.hostDiscussionId ?? "";
    const threadNotes =
      discussionForThread.length > 0
        ? await this.codeHost.getDiscussionNotes(
            projectId,
            mrIid,
            discussionForThread,
          )
        : [];

    const commentSection =
      threadNotes.length > 1
        ? `Discussion thread:\n${threadNotes.map((n) => `@${n.author}: ${n.body}`).join("\n\n")}`
        : `Developer comment:\n${developerNote}`;

    const replyModel = this.resolveTriageModelForReply(repoConfig);
    const toolsAvailableInPrompt = this.canUseToolsForReply(replyModel);
    const overlayViewPreset = await this.buildMrOverlayView(
      projectId,
      versions,
      overlayPathLists.changedPaths,
      overlayPathLists.deletedPaths,
    );

    if (!overlayViewPreset) {
      this.logger.info(
        { mrIid, projectId },
        FINDING_THREAD_CLARIFICATION_BASELINE_UNAVAILABLE_LOG,
      );
      return runNarrowFindingClarification({
        costBudget,
        costModel: resolveDefaultLlmModel(
          this.llmConfig,
          this.openRouterConfig,
        ),
        developerNote,
        finding,
        llm: this.llm,
        logger: this.logger,
      });
    }

    const userPrompt = buildFindingThreadClarificationUserPrompt({
      appendToolsCompletionInstruction: toolsAvailableInPrompt,
      architectureSnapshot,
      developerNote,
      diffText,
      finding,
      mrInfo,
      priorFindingsSummary,
      threadSection: commentSection,
    });

    const maxToolRounds =
      this.pipelineConfig.envs.COMMENT_RESPONSE_MAX_TOOL_ROUNDS;
    const systemPrompt = buildFindingThreadClarificationSystemPrompt(
      projectRulesText,
      pathRulesText,
      { maxToolRounds, toolsAvailable: toolsAvailableInPrompt },
    );

    return this.composeAssistantCommentReply({
      costBudget,
      maxPromptTokensHard:
        this.pipelineConfig.envs.FINDING_THREAD_PROMPT_HARD_LIMIT,
      maxTokens: COMMENT_ASSISTANT_REPLY_MAX_TOKENS,
      maxToolRounds,
      mrIid,
      mrParsedDiffs: parsedDiffs,
      overlayChangedPaths: overlayPathLists.changedPaths,
      overlayDeletedPaths: overlayPathLists.deletedPaths,
      overlayViewPreset,
      projectId,
      replyModel,
      systemPrompt,
      userPrompt,
      versions,
    });
  }

  async reviewMergeRequest(
    projectId: number,
    mrIid: number,
    triggerType: TriggerType,
    previousRunId?: string,
  ): Promise<void> {
    this.logger.info({ mrIid, projectId, triggerType }, "Starting MR review");

    const [diffs, versions] = await Promise.all([
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);

    const { parsedDiffs } = this.prepareDiffs(diffs);

    if (parsedDiffs.length === 0) {
      this.logger.info({ mrIid, projectId }, "No reviewable diffs found");
      return;
    }

    await this.orchestrator.run({
      diffs: parsedDiffs,
      mrIid,

      previousRunId,

      projectId,

      triggerType,

      versions,
    });
  }

  private prepareDiffs(
    diffs: DiffFile[],
    charCap?: number,
  ): {
    diffText: string;
    parsedDiffs: ParsedFileDiff[];
  } {
    const limit =
      charCap ?? this.pipelineConfig.envs.COMMENT_RESPONSE_MAX_DIFF_LENGTH;
    const parsedDiffs = diffs.map(parseDiff);
    const formattedFiles = parsedDiffs.map(formatParsedDiffForPrompt);
    let diffText = "";

    for (const fileDiff of formattedFiles) {
      if (diffText.length + fileDiff.length + 2 > limit) {
        diffText += "\n\n... (remaining files truncated)";
        break;
      }

      diffText += (diffText.length > 0 ? "\n\n" : "") + fileDiff;
    }

    return { diffText, parsedDiffs };
  }
}

export { ReviewService };
