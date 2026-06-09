import type { FastifyBaseLogger } from "fastify";
import PQueue from "p-queue";
import { toJSONSchema, z } from "zod";

import { computeCostUsd } from "~/config/llm-pricing";
import { OVERLAY_VIEW_DEFAULTS } from "~/config/pipeline.config";
import { parseLlmJson } from "~/domain/llm/parse-llm-json";
import type { IDocProvider } from "~/domain/ports/doc-provider.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { ToolDefinition } from "~/domain/types/llm.types";
import type {
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding } from "~/domain/types/review.types";
import { PromptTokenBudgetExceededError } from "~/infrastructure/llm/estimate-prompt-tokens";
import { shouldApplyCachePrefix } from "~/infrastructure/llm/prompt-cache/assert-cache-prefix";
import type { TokenBucket } from "~/infrastructure/rate-limiter/token-bucket";
import {
  fetchDocContextForFile,
  resolveLibrariesFromDiffs,
} from "~/pipeline/context/doc-context";
import type { ResolvedLibraries } from "~/pipeline/context/doc-context";
import { docQueryTool, executeDocTool } from "~/pipeline/context/doc-tool";
import {
  buildFileReviewAnalysisSystemBlocks,
  buildFileReviewAnalysisUserPrompt,
  buildFileReviewExtractionSystemBlocks,
  buildFileReviewExtractionUserPrompt,
} from "~/pipeline/prompts/file-review.prompt";
import { resolveProjectAndPathRulesText } from "~/pipeline/prompts/resolve-path-rules";
import { codebaseTools, diffHunkTool } from "~/pipeline/tools/codebase-tools";
import { createDedupeToolExecutor } from "~/pipeline/tools/dedupe-tool-executor";
import { executeDiffHunkTool } from "~/pipeline/tools/execute-diff-hunk-tool";
import { formatParsedDiffForPromptWithBudget } from "~/review/diff-parser";
import { validateFindingPositionInHunk } from "~/review/finding-position-validation";
import { sanitizeSuggestionAndComment } from "~/review/suggestion-sanitizer";

const FileFindingSchema = z.object({
  category: z.string().default("best_practice"),
  comment: z.string(),
  confidence: z.number().default(0.8),
  end_line: z.number().int().nullable().optional(),
  file_path: z.string(),
  line_number: z.number().int(),
  line_type: z.enum(["added", "removed", "context"]).catch("added"),
  old_path: z.string().nullable().optional(),
  original_snippet: z.string().nullable().optional().catch(null),
  severity: z
    .enum(["critical", "attention", "warning", "info", "nitpick"])
    .catch("info"),
  suggestion: z.string().nullable().optional(),
});

const FileReviewResponseSchema = z.object({
  findings: z.array(FileFindingSchema),
});

const FILE_REVIEW_JSON_SCHEMA = toJSONSchema(FileReviewResponseSchema);

const DEFAULT_DOC_MAX_TOKENS = 2500;
const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_ROUNDS_TRIAGE = 5;
const BASE_TOOL_ROUNDS = 3;
const HIGH_RISK_FILE_DIFF_LINES = 180;
const CODEBASE_TOOLS_MIN_DIFF_LINES = 10;
const FILE_REVIEW_ANALYSIS_MAX_TOKENS = 2200;
const FILE_REVIEW_ANALYSIS_TRIAGE_MAX_TOKENS = 1100;
const FILE_REVIEW_EXTRACTION_MAX_TOKENS = 1200;
const FILE_REVIEW_TEMPERATURE = 0.1;
const MISSING_FILE_CLAIM_REGEX =
  /(does\s+not\s+exist|not\s+found|missing\s+file|not\s+imported|neither\s+imported|not\s+declared|reference\s*error|не\s+существ|несуществующ|не\s+найден|не\s+импортир|не\s+объявл)/i;
const IMPORT_MENTION_REGEX = /(import|импорт)/i;
const MIN_GROUNDABLE_SNIPPET_LENGTH = 12;
const VERIFIED_REPO_PATH_MARKER_REGEX =
  /\[\s*verified_repo_path\s*:\s*([^\]\s]+)\s*\]/i;

function mapToFinding(
  item: z.infer<typeof FileFindingSchema>,
  passName: string,
  model: string,
): Finding {
  return {
    category: item.category,
    comment: item.comment,
    confidence: item.confidence,
    endLineNumber:
      item.end_line !== null && item.end_line !== undefined
        ? item.end_line
        : undefined,
    filePath: item.file_path,
    lineNumber: item.line_number,
    lineType: item.line_type,
    model,
    oldPath: item.old_path ?? undefined,
    originalSnippet: item.original_snippet ?? undefined,
    passName,
    severity: item.severity,
    suggestion: item.suggestion ?? undefined,
  };
}

function resolveMaxToolRounds(
  isTriageOnly: boolean,
  diffLineCount: number,
): number {
  if (isTriageOnly) return MAX_TOOL_ROUNDS_TRIAGE;
  if (diffLineCount >= HIGH_RISK_FILE_DIFF_LINES) return MAX_TOOL_ROUNDS;
  return BASE_TOOL_ROUNDS;
}

function shouldGateMissingFileFinding(comment: string): boolean {
  return (
    MISSING_FILE_CLAIM_REGEX.test(comment) && IMPORT_MENTION_REGEX.test(comment)
  );
}

function normalizeForGrounding(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isFindingSnippetGrounded(
  snippet: string | null | undefined,
  diff: ParsedFileDiff,
): boolean {
  if (snippet === null || snippet === undefined) return true;
  const needle = normalizeForGrounding(snippet);
  if (needle.length < MIN_GROUNDABLE_SNIPPET_LENGTH) return true;
  const haystack = normalizeForGrounding(
    diff.lines.map((line) => line.content).join("\n"),
  );
  return haystack.includes(needle);
}

function applyMissingFileVerificationGate(params: {
  comment: string;
  filePath: string;
  logger: FastifyBaseLogger;
  mrIid: number;
  projectId: number;
  reviewRunId: string;
}): { normalizedComment: string; shouldKeep: boolean } {
  const { comment, filePath, logger, mrIid, projectId, reviewRunId } = params;
  if (!shouldGateMissingFileFinding(comment)) {
    return { normalizedComment: comment, shouldKeep: true };
  }
  const markerMatch = VERIFIED_REPO_PATH_MARKER_REGEX.exec(comment);
  if (!markerMatch) {
    logger.warn(
      {
        filePath,
        mrIid,
        projectId,
        reviewRunId,
      },
      "Dropping unverified missing-file finding",
    );
    return { normalizedComment: comment, shouldKeep: false };
  }
  const normalizedComment = comment
    .replace(VERIFIED_REPO_PATH_MARKER_REGEX, "")
    .trim();
  return {
    normalizedComment:
      normalizedComment.length > 0 ? normalizedComment : comment,
    shouldKeep: true,
  };
}

function addUsageToModelTotals(
  totals: Map<string, { completionTokens: number; promptTokens: number }>,
  model: string,
  usage: {
    completionTokens: number;
    promptTokens: number;
  },
): void {
  const existing = totals.get(model) ?? {
    completionTokens: 0,
    promptTokens: 0,
  };
  totals.set(model, {
    completionTokens: existing.completionTokens + usage.completionTokens,
    promptTokens: existing.promptTokens + usage.promptTokens,
  });
}

class FileReviewPass implements IReviewPass<Record<string, unknown>> {
  readonly name = "file-review";

  constructor(
    private readonly llm: ILlmClient,
    private readonly logger: FastifyBaseLogger,
    private readonly docProvider?: IDocProvider,
    private readonly rateLimiter?: TokenBucket,
    private readonly promptHardLimit?: number,
    private readonly maxDiffCharacters?: number,
  ) {}

  async execute(
    context: ReviewContext,
    _priorResults: Map<string, PassResult>,
  ): Promise<PassResult<Record<string, unknown>>> {
    const { diffs, mrInfo, reviewConfig } = context;

    if (diffs.length === 0) {
      this.logger.debug(
        {
          mrIid: context.mrIid,
          projectId: context.projectId,
          reviewRunId: context.reviewRunId,
        },
        "File review skipped: no diffs",
      );
      return {
        findings: [],
        metadata: {},
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    let resolvedLibraries: ResolvedLibraries | undefined;
    if (this.docProvider) {
      resolvedLibraries = await resolveLibrariesFromDiffs(
        diffs,
        this.docProvider,
        this.logger,
      );
    }

    const concurrency = reviewConfig.concurrency?.maxParallelFiles ?? 8;
    const queue = new PQueue({ concurrency });

    this.logger.info(
      {
        concurrency,
        fileCount: diffs.length,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
      },
      "File review pass starting",
    );
    const fileReviewCounters = {
      filesAbortedNoFinal: 0,
      filesErrored: 0,
      filesParseFailed: 0,
      filesSkippedBudget: 0,
      filesSkippedCostCeiling: 0,
      filesSucceeded: 0,
      filesWithDocQueryTool: 0,
      filesWithEagerDocContext: 0,
      filesWithTools: 0,
    };

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const allFindings: Finding[] = [];
    let allFilesFailed = true;
    const allowedPaths = new Set(
      diffs.flatMap((diff) => [diff.newPath, diff.oldPath]),
    );
    let totalUserPromptChars = 0;
    let totalToolCalls = 0;
    let totalToolRounds = 0;
    let totalRequestedToolRounds = 0;
    const tokensByModel = new Map<
      string,
      { completionTokens: number; promptTokens: number }
    >();

    const overlayExecutor = context.overlayView?.createToolExecutor();
    const budget = context.costBudget;

    const tasks = diffs.map((diff) =>
      queue.add(async () => {
        if (budget?.isExhausted()) {
          fileReviewCounters.filesSkippedCostCeiling++;
          return;
        }
        const model = reviewConfig.models.review;

        const { pathRules, projectRules } = resolveProjectAndPathRulesText({
          filePaths: [diff.newPath],
          pathRules: reviewConfig.pathRules ?? [],
        });
        const diffPromptPayload = formatParsedDiffForPromptWithBudget(
          diff,
          this.maxDiffCharacters !== undefined
            ? { maxCharacters: this.maxDiffCharacters }
            : undefined,
        );
        const diffText = diffPromptPayload.text;
        const isTriageOnly = diffPromptPayload.isTruncated;
        const canUseDocTool = Boolean(this.docProvider && !isTriageOnly);
        const modelForRequest = isTriageOnly
          ? reviewConfig.models.triage
          : model;

        const snapshotForFile = isTriageOnly
          ? undefined
          : context.architectureSnapshot;
        const analysisCandidateBlocks = buildFileReviewAnalysisSystemBlocks(
          projectRules,
          snapshotForFile,
          false,
        );
        const candidatePrefixText = analysisCandidateBlocks
          .map((b) => b.text)
          .join("\n");
        const applyCache = shouldApplyCachePrefix(
          candidatePrefixText,
          modelForRequest,
          this.logger,
        );
        const analysisSystemBlocks = applyCache
          ? buildFileReviewAnalysisSystemBlocks(
              projectRules,
              snapshotForFile,
              true,
            )
          : analysisCandidateBlocks;

        let docContext: string | undefined;
        if (this.docProvider && resolvedLibraries && !canUseDocTool) {
          const fileDiffContent = diff.lines.map((l) => l.content).join("\n");
          docContext = await fetchDocContextForFile(
            fileDiffContent,
            resolvedLibraries,
            this.docProvider,
            this.logger,
            isTriageOnly
              ? Math.floor(DEFAULT_DOC_MAX_TOKENS / 2)
              : DEFAULT_DOC_MAX_TOKENS,
          );
          if (docContext) {
            fileReviewCounters.filesWithEagerDocContext++;
          }
        }

        const analysisUserPrompt = buildFileReviewAnalysisUserPrompt(
          mrInfo,
          diffText,
          pathRules,
          undefined,
          docContext || undefined,
        );
        totalUserPromptChars += analysisUserPrompt.length;

        try {
          if (this.rateLimiter) {
            await this.rateLimiter.acquire();
          }

          const codebaseToolsEnabled =
            context.overlayView !== undefined &&
            diff.lines.length >= CODEBASE_TOOLS_MIN_DIFF_LINES;
          const diffHunkEligible =
            context.overlayView !== undefined &&
            (diffPromptPayload.isTruncated || codebaseToolsEnabled);
          const rawToolExecutorForFile = async (call: {
            arguments: Record<string, unknown>;
            id: string;
            name: string;
          }): Promise<string> => {
            if (call.name === "doc_query" && this.docProvider) {
              return executeDocTool(call, this.docProvider);
            }
            if (call.name === "diff_hunk" && context.overlayView) {
              return executeDiffHunkTool({
                call,
                maxToolChars: OVERLAY_VIEW_DEFAULTS.maxToolResponseChars,
                overlay: context.overlayView,
                parsed: diff,
              });
            }
            if (overlayExecutor) {
              return overlayExecutor(call);
            }
            return `Tool not available: ${call.name}`;
          };
          const toolExecutorForFile = createDedupeToolExecutor(
            rawToolExecutorForFile,
            context.toolCallCache,
          );
          const tools: ToolDefinition[] = [];
          if (codebaseToolsEnabled) {
            tools.push(...codebaseTools);
          }
          if (diffHunkEligible) {
            tools.push(diffHunkTool);
          }
          if (canUseDocTool) {
            tools.push(docQueryTool);
            fileReviewCounters.filesWithDocQueryTool++;
          }
          if (tools.length > 0) {
            fileReviewCounters.filesWithTools++;
          }
          const maxToolRounds = resolveMaxToolRounds(
            isTriageOnly,
            diff.lines.length,
          );
          totalRequestedToolRounds += maxToolRounds;

          const responsePhaseA = await this.llm.chatCompletionWithTools(
            [
              { content: analysisSystemBlocks, role: "system" },
              { content: analysisUserPrompt, role: "user" },
            ],
            tools,
            toolExecutorForFile,
            {
              maxPromptTokensHard: this.promptHardLimit,
              maxTokens: isTriageOnly
                ? FILE_REVIEW_ANALYSIS_TRIAGE_MAX_TOKENS
                : FILE_REVIEW_ANALYSIS_MAX_TOKENS,
              maxToolRounds,
              model: modelForRequest,
              reasoning: { effort: "low" },
              temperature: FILE_REVIEW_TEMPERATURE,
            },
          );

          totalPromptTokens += responsePhaseA.usage.promptTokens;
          totalCompletionTokens += responsePhaseA.usage.completionTokens;
          totalToolCalls += responsePhaseA.usage.toolCalls ?? 0;
          totalToolRounds += responsePhaseA.usage.toolRounds ?? 0;
          addUsageToModelTotals(tokensByModel, modelForRequest, {
            completionTokens: responsePhaseA.usage.completionTokens,
            promptTokens: responsePhaseA.usage.promptTokens,
          });
          budget?.record(
            computeCostUsd(modelForRequest, {
              inputTokens: responsePhaseA.usage.promptTokens,
              outputTokens: responsePhaseA.usage.completionTokens,
            }),
          );
          if (
            responsePhaseA.usage.cacheCreationInputTokens !== undefined ||
            responsePhaseA.usage.cacheReadInputTokens !== undefined
          ) {
            this.logger.debug(
              {
                cacheCreation: responsePhaseA.usage.cacheCreationInputTokens,
                cacheRead: responsePhaseA.usage.cacheReadInputTokens,
                file: diff.newPath,
                model: modelForRequest,
                phase: "file-review-analysis",
              },
              "file-review cache usage",
            );
          }

          if (responsePhaseA.content === null) {
            allFilesFailed = false;
            fileReviewCounters.filesAbortedNoFinal++;
            this.logger.warn(
              {
                codebaseToolsEnabled,
                diffLineCount: diff.lines.length,
                file: diff.newPath,
                maxToolRounds,
                model: modelForRequest,
                mrIid: context.mrIid,
                projectId: context.projectId,
                reviewRunId: context.reviewRunId,
                toolCalls: responsePhaseA.usage.toolCalls ?? 0,
                toolRounds: responsePhaseA.usage.toolRounds ?? 0,
              },
              "File review aborted: tool loop exhausted before final assistant response — skipping file",
            );
          } else {
            const analysisText = responsePhaseA.content.trim();
            if (analysisText.length === 0) {
              allFilesFailed = false;
              fileReviewCounters.filesSucceeded++;
              this.logger.warn(
                {
                  file: diff.newPath,
                  mrIid: context.mrIid,
                  projectId: context.projectId,
                  reviewRunId: context.reviewRunId,
                },
                "File review phase A returned empty analysis — skipping extraction",
              );
            } else {
              const extractionSystemBlocks =
                buildFileReviewExtractionSystemBlocks(true);
              const extractionUserPrompt = buildFileReviewExtractionUserPrompt({
                allowableAnchorsText: diffPromptPayload.allowableAnchorsText,
                analysisText,
                filePath: diff.newPath,
              });
              totalUserPromptChars += extractionUserPrompt.length;
              const responsePhaseB = await this.llm.chatCompletion(
                [
                  { content: extractionSystemBlocks, role: "system" },
                  { content: extractionUserPrompt, role: "user" },
                ],
                {
                  maxPromptTokensHard: this.promptHardLimit,
                  maxTokens: FILE_REVIEW_EXTRACTION_MAX_TOKENS,
                  model: modelForRequest,
                  responseSchema: FILE_REVIEW_JSON_SCHEMA,
                  temperature: FILE_REVIEW_TEMPERATURE,
                },
              );
              totalPromptTokens += responsePhaseB.usage.promptTokens;
              totalCompletionTokens += responsePhaseB.usage.completionTokens;
              addUsageToModelTotals(tokensByModel, modelForRequest, {
                completionTokens: responsePhaseB.usage.completionTokens,
                promptTokens: responsePhaseB.usage.promptTokens,
              });
              budget?.record(
                computeCostUsd(modelForRequest, {
                  inputTokens: responsePhaseB.usage.promptTokens,
                  outputTokens: responsePhaseB.usage.completionTokens,
                }),
              );
              if (
                responsePhaseB.usage.cacheCreationInputTokens !== undefined ||
                responsePhaseB.usage.cacheReadInputTokens !== undefined
              ) {
                this.logger.debug(
                  {
                    cacheCreation:
                      responsePhaseB.usage.cacheCreationInputTokens,
                    cacheRead: responsePhaseB.usage.cacheReadInputTokens,
                    file: diff.newPath,
                    model: modelForRequest,
                    phase: "file-review-extraction",
                  },
                  "file-review cache usage",
                );
              }
              if (responsePhaseB.content === null) {
                allFilesFailed = false;
                fileReviewCounters.filesParseFailed++;
                this.logger.warn(
                  {
                    file: diff.newPath,
                    model: modelForRequest,
                    mrIid: context.mrIid,
                    projectId: context.projectId,
                    reviewRunId: context.reviewRunId,
                  },
                  "File review extraction returned null content",
                );
              } else {
                const raw: unknown = parseLlmJson(responsePhaseB.content);
                const parsed = FileReviewResponseSchema.safeParse(raw);
                if (parsed.success) {
                  allFilesFailed = false;
                  fileReviewCounters.filesSucceeded++;
                  const findings = parsed.data.findings
                    .filter((item) => {
                      if (allowedPaths.has(item.file_path)) return true;
                      this.logger.warn(
                        {
                          mrIid: context.mrIid,
                          off_diff_path: item.file_path,
                          pass: "file-review",
                          projectId: context.projectId,
                          reviewRunId: context.reviewRunId,
                        },
                        "Dropping off-diff finding",
                      );
                      return false;
                    })
                    .filter((item) => {
                      const positionValidation = validateFindingPositionInHunk(
                        item,
                        diff,
                      );
                      if (positionValidation.valid) {
                        return true;
                      }
                      this.logger.warn(
                        {
                          endLine: item.end_line ?? undefined,
                          filePath: item.file_path,
                          lineNumber: item.line_number,
                          lineType: item.line_type,
                          mrIid: context.mrIid,
                          pass: "file-review",
                          projectId: context.projectId,
                          reason: positionValidation.reason,
                          reviewRunId: context.reviewRunId,
                        },
                        "Dropping off-hunk finding",
                      );
                      return false;
                    })
                    .filter((item) => {
                      if (isFindingSnippetGrounded(item.original_snippet, diff)) {
                        return true;
                      }
                      this.logger.warn(
                        {
                          filePath: item.file_path,
                          lineNumber: item.line_number,
                          mrIid: context.mrIid,
                          pass: "file-review",
                          projectId: context.projectId,
                          reviewRunId: context.reviewRunId,
                        },
                        "Dropping finding with ungrounded original_snippet",
                      );
                      return false;
                    })
                    .map((item) => {
                      const gating = applyMissingFileVerificationGate({
                        comment: item.comment,
                        filePath: item.file_path,
                        logger: this.logger,
                        mrIid: context.mrIid,
                        projectId: context.projectId,
                        reviewRunId: context.reviewRunId,
                      });
                      if (!gating.shouldKeep) {
                        return null;
                      }
                      const sanitized = sanitizeSuggestionAndComment({
                        comment: gating.normalizedComment,
                        suggestion: item.suggestion,
                      });
                      return mapToFinding(
                        {
                          ...item,
                          comment: sanitized.comment,
                          suggestion:
                            sanitized.suggestion !== undefined
                              ? sanitized.suggestion
                              : null,
                        },
                        "file-review",
                        model,
                      );
                    })
                    .filter((finding): finding is Finding => finding !== null);
                  allFindings.push(...findings);
                } else {
                  allFilesFailed = false;
                  fileReviewCounters.filesParseFailed++;
                  this.logger.warn(
                    {
                      errors: parsed.error.issues.slice(0, 3),
                      file: diff.newPath,
                      rawContent: String(responsePhaseB.content).slice(0, 500),
                    },
                    "Failed to parse file review extraction response",
                  );
                }
              }
            }
          }
        } catch (err) {
          if (err instanceof PromptTokenBudgetExceededError) {
            allFilesFailed = false;
            fileReviewCounters.filesSkippedBudget++;
            this.logger.warn(
              {
                estimatedTokens: err.estimatedTokens,
                file: diff.newPath,
                hardLimit: err.hardLimit,
                model: reviewConfig.models.review,
              },
              "File review skipped: per-file prompt token hard limit exceeded",
            );
          } else {
            fileReviewCounters.filesErrored++;
            this.logger.error(
              { err, file: diff.newPath },
              "File review failed, skipping file",
            );
          }
        }
      }),
    );

    await Promise.all(tasks);

    this.logger.info(
      {
        ...fileReviewCounters,
        avgRequestedToolRounds:
          diffs.length > 0 ? totalRequestedToolRounds / diffs.length : 0,
        avgUserPromptChars:
          diffs.length > 0 ? totalUserPromptChars / diffs.length : 0,
        findingsCount: allFindings.length,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
        totalCompletionTokens,
        totalPromptTokens,
        totalRequestedToolRounds,
        totalToolCalls,
        totalToolRounds,
        totalUserPromptChars,
      },
      "File review pass completed",
    );

    const everyFileSkippedForCostCeiling =
      fileReviewCounters.filesSkippedCostCeiling === diffs.length;
    if (allFilesFailed && diffs.length > 0 && !everyFileSkippedForCostCeiling) {
      throw new Error("All file reviews failed");
    }

    return {
      findings: allFindings,
      metadata: {
        avgRequestedToolRounds:
          diffs.length > 0 ? totalRequestedToolRounds / diffs.length : 0,
        avgUserPromptChars:
          diffs.length > 0 ? totalUserPromptChars / diffs.length : 0,
        costCeilingHit: fileReviewCounters.filesSkippedCostCeiling > 0,
        filesSkippedCostCeiling: fileReviewCounters.filesSkippedCostCeiling,
        filesWithDocQueryTool: fileReviewCounters.filesWithDocQueryTool,
        filesWithEagerDocContext: fileReviewCounters.filesWithEagerDocContext,
        filesWithTools: fileReviewCounters.filesWithTools,
        totalRequestedToolRounds,
        totalToolCalls,
        totalToolRounds,
        totalUserPromptChars,
      },
      tokenUsage: {
        completionTokens: totalCompletionTokens,
        promptTokens: totalPromptTokens,
      },
      tokenUsageByModel: Object.fromEntries(tokensByModel),
    };
  }
}

export { FileReviewPass };
