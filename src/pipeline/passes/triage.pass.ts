import type { FastifyBaseLogger } from "fastify";
import { toJSONSchema, z } from "zod";

import { computeCostUsd } from "~/config/llm-pricing";
import { parseLlmJson } from "~/domain/llm/parse-llm-json";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import type {
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import { estimatePromptTokens } from "~/infrastructure/llm/estimate-prompt-tokens";
import type {
  IPipelineMetrics,
  TriageParseOutcome,
} from "~/domain/ports/pipeline-metrics.port";
import { parseProseTriageResponse } from "~/pipeline/passes/triage.prose-fallback";
import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  type TriageHunkInput,
} from "~/pipeline/prompts/triage.prompt";

const TRIAGE_BATCH_PROMPT_TOKEN_BUDGET = 6000;
const TRIAGE_MAX_TOKENS_PER_HUNK = 12;
const TRIAGE_MIN_MAX_TOKENS = 200;
const TRIAGE_MAX_TRIVIAL_SHARE = 0.4;

const TriageResponseSchema = z.object({
  results: z.array(
    z.object({
      hunk_id: z.number().int().nonnegative(),
      verdict: z.enum(["needs-review", "trivial"]).catch("needs-review"),
    }),
  ),
});

const TriageResponseSchemaMerged = z
  .object({
    results: z.array(
      z.object({
        decision: z
          .enum(["needs-review", "trivial"])
          .optional()
          .catch("needs-review"),
        hunk_id: z
          .union([z.number().int().nonnegative(), z.string().transform(Number)])
          .optional(),
        hunk_index: z
          .union([z.number().int().nonnegative(), z.string().transform(Number)])
          .optional(),
        verdict: z.enum(["needs-review", "trivial"]).catch("needs-review"),
      }),
    ),
  })
  .transform((data) => ({
    results: data.results.map((item) => ({
      hunk_id: item.hunk_id ?? item.hunk_index ?? 0,
      verdict: item.verdict ?? item.decision ?? "needs-review",
    })),
  }));

const TRIAGE_JSON_SCHEMA = toJSONSchema(TriageResponseSchema);

type TriageVerdict = "needs-review" | "trivial";

interface TriageDecision {
  filePath: string;
  hunkHeader: string;
  verdict: TriageVerdict;
}

interface TriagePassMetadata {
  avgBatchEstimatedTokens?: number;
  decisions: readonly TriageDecision[];
  parseFailures: number;
  totalBatches: number;
  totalEstimatedPromptTokens?: number;
  triageSkipRate: number;
  trivialHunkCount: number;
  trivialKeys: ReadonlySet<string>;
}

interface InternalHunk {
  body: string;
  filePath: string;
  header: string;
  id: number;
  key: string;
  lines: readonly DiffLine[];
}

interface BatchLogContext {
  batchIndex: number;
  model: string;
  mrIid: number;
  projectId: number;
  reviewRunId: string;
}

const RAW_CONTENT_LOG_LIMIT = 2000;

function truncateForLog(value: string): string {
  if (value.length <= RAW_CONTENT_LOG_LIMIT) {
    return value;
  }
  return `${value.slice(0, RAW_CONTENT_LOG_LIMIT)}…[truncated]`;
}

function hunkKey(filePath: string, hunkHeader: string): string {
  return `${filePath}${hunkHeader}`;
}

function renderHunkBody(lines: readonly DiffLine[]): string {
  return lines
    .map((line) => {
      const prefix =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      return `${prefix}${line.content}`;
    })
    .join("\n");
}

function extractHunks(diffs: readonly ParsedFileDiff[]): InternalHunk[] {
  const hunks: InternalHunk[] = [];
  let nextId = 0;

  for (const diff of diffs) {
    const grouped = new Map<string, DiffLine[]>();
    for (const line of diff.lines) {
      const header = line.hunkHeader;
      let bucket = grouped.get(header);
      if (!bucket) {
        bucket = [];
        grouped.set(header, bucket);
      }
      bucket.push(line);
    }

    for (const [header, lines] of grouped) {
      hunks.push({
        body: renderHunkBody(lines),
        filePath: diff.newPath,
        header,
        id: nextId++,
        key: hunkKey(diff.newPath, header),
        lines,
      });
    }
  }

  return hunks;
}

function applyTriageFilter(
  diffs: readonly ParsedFileDiff[],
  trivialKeys: ReadonlySet<string>,
): ParsedFileDiff[] {
  if (trivialKeys.size === 0) {
    return [...diffs];
  }

  const result: ParsedFileDiff[] = [];
  for (const diff of diffs) {
    const keptLines = diff.lines.filter(
      (line) => !trivialKeys.has(hunkKey(diff.newPath, line.hunkHeader)),
    );
    if (keptLines.length === 0) {
      continue;
    }
    result.push({
      lines: keptLines,
      newPath: diff.newPath,
      oldPath: diff.oldPath,
    });
  }
  return result;
}

interface ApplyConservativeCapResult {
  decisions: TriageDecision[];
  demotedTrivialCount: number;
  maxAllowedTrivialCount: number;
  trivialKeys: Set<string>;
}

function applyConservativeCap(
  hunks: readonly InternalHunk[],
  decisions: readonly TriageDecision[],
  trivialKeys: ReadonlySet<string>,
): ApplyConservativeCapResult {
  const maxAllowedTrivialCount = Math.floor(
    hunks.length * TRIAGE_MAX_TRIVIAL_SHARE,
  );
  if (trivialKeys.size <= maxAllowedTrivialCount) {
    return {
      decisions: [...decisions],
      demotedTrivialCount: 0,
      maxAllowedTrivialCount,
      trivialKeys: new Set(trivialKeys),
    };
  }
  let remainingTrivialBudget = maxAllowedTrivialCount;
  const cappedTrivialKeys = new Set<string>();
  for (const hunk of hunks) {
    if (remainingTrivialBudget === 0) {
      break;
    }
    if (!trivialKeys.has(hunk.key)) {
      continue;
    }
    cappedTrivialKeys.add(hunk.key);
    remainingTrivialBudget--;
  }
  const cappedDecisions = decisions.map((decision) => {
    if (decision.verdict !== "trivial") {
      return decision;
    }
    const key = hunkKey(decision.filePath, decision.hunkHeader);
    if (cappedTrivialKeys.has(key)) {
      return decision;
    }
    return { ...decision, verdict: "needs-review" as const };
  });
  return {
    decisions: cappedDecisions,
    demotedTrivialCount: trivialKeys.size - cappedTrivialKeys.size,
    maxAllowedTrivialCount,
    trivialKeys: cappedTrivialKeys,
  };
}

function emptyMetadata(): TriagePassMetadata {
  return {
    avgBatchEstimatedTokens: 0,
    decisions: [],
    parseFailures: 0,
    totalBatches: 0,
    totalEstimatedPromptTokens: 0,
    triageSkipRate: 0,
    trivialHunkCount: 0,
    trivialKeys: new Set<string>(),
  };
}

class TriagePass implements IReviewPass<TriagePassMetadata> {
  readonly name = "triage";

  constructor(
    private readonly llm: ILlmClient,
    private readonly logger: FastifyBaseLogger,
    private readonly promptHardLimit?: number,
    private readonly metrics?: IPipelineMetrics,
  ) {}

  private observeOutcome(model: string, outcome: TriageParseOutcome): void {
    if (this.metrics) {
      this.metrics.observeTriageParseOutcome(model, outcome);
    }
  }

  private estimateBatchPromptTokens(
    systemPrompt: string,
    hunks: InternalHunk[],
  ): number {
    const userPrompt = buildTriageUserPrompt(
      hunks.map<TriageHunkInput>((h) => ({
        body: h.body,
        filePath: h.filePath,
        header: h.header,
        id: h.id,
      })),
    );
    return estimatePromptTokens([
      { content: systemPrompt, role: "system" },
      { content: userPrompt, role: "user" },
    ]);
  }

  private buildBatches(
    hunks: InternalHunk[],
    systemPrompt: string,
  ): InternalHunk[][] {
    const batches: InternalHunk[][] = [];
    let current: InternalHunk[] = [];

    for (const hunk of hunks) {
      current.push(hunk);
      const estimated = this.estimateBatchPromptTokens(systemPrompt, current);
      if (estimated > TRIAGE_BATCH_PROMPT_TOKEN_BUDGET && current.length > 1) {
        current.pop();
        batches.push(current);
        current = [hunk];
      }
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  }

  private processBatchResults(
    batchHunks: InternalHunk[],
    rawContent: string,
    hunkById: Map<number, InternalHunk>,
    decisions: TriageDecision[],
    trivialKeys: Set<string>,
    seenIds: Set<number>,
    logContext: BatchLogContext,
  ): { parseFailed: boolean; trivialCount: number } {
    const raw: unknown = parseLlmJson(rawContent);
    const parsed = TriageResponseSchema.safeParse(raw);

    const mergedParsed = !parsed.success
      ? TriageResponseSchemaMerged.safeParse(raw)
      : parsed;

    if (!mergedParsed.success) {
      const proseFallback = parseProseTriageResponse(rawContent, {
        expectedHunkIds: batchHunks.map((h) => h.id),
      });
      if (proseFallback !== null) {
        const proseParsed = TriageResponseSchema.safeParse(proseFallback);
        if (proseParsed.success) {
          this.logger.warn(
            {
              ...logContext,
              batchSize: batchHunks.length,
              resultCount: proseParsed.data.results.length,
            },
            "Triage batch parsed via prose fallback (model emitted markdown instead of JSON)",
          );
          this.observeOutcome(logContext.model, "prose_fallback");
          return this.applyParsedTriageResults(
            batchHunks,
            proseParsed.data.results,
            hunkById,
            decisions,
            trivialKeys,
            seenIds,
          );
        }
      }
    }

    if (!mergedParsed.success) {
      this.logger.error(
        {
          ...logContext,
          batchSize: batchHunks.length,
          errors: mergedParsed.error.issues,
          fallbackAttempted: !parsed.success,
          parsedType: typeof raw,
          parsedValue: raw,
          rawContent: truncateForLog(rawContent),
          rawContentLength: rawContent.length,
        },
        "TRIAGE_PARSE_FAILURE: Failed to parse triage batch response",
      );
      this.observeOutcome(logContext.model, "parse_failed");
      for (const hunk of batchHunks) {
        if (!seenIds.has(hunk.id)) {
          seenIds.add(hunk.id);
          decisions.push({
            filePath: hunk.filePath,
            hunkHeader: hunk.header,
            verdict: "needs-review",
          });
        }
      }
      return { parseFailed: true, trivialCount: 0 };
    }

    this.logger.info(
      {
        ...logContext,
        batchSize: batchHunks.length,
        resultCount: mergedParsed.data.results.length,
      },
      "Triage batch parsed successfully",
    );
    this.observeOutcome(
      logContext.model,
      parsed.success ? "json_strict" : "json_merged",
    );
    return this.applyParsedTriageResults(
      batchHunks,
      mergedParsed.data.results,
      hunkById,
      decisions,
      trivialKeys,
      seenIds,
    );
  }

  private applyParsedTriageResults(
    batchHunks: InternalHunk[],
    parsedResults: ReadonlyArray<{ hunk_id: number; verdict: TriageVerdict }>,
    hunkById: Map<number, InternalHunk>,
    decisions: TriageDecision[],
    trivialKeys: Set<string>,
    seenIds: Set<number>,
  ): { parseFailed: boolean; trivialCount: number } {
    let trivialCount = 0;
    for (const item of parsedResults) {
      const hunk = hunkById.get(item.hunk_id);
      if (!hunk || seenIds.has(item.hunk_id)) {
        continue;
      }
      seenIds.add(item.hunk_id);

      decisions.push({
        filePath: hunk.filePath,
        hunkHeader: hunk.header,
        verdict: item.verdict,
      });

      if (item.verdict === "trivial") {
        trivialCount++;
        trivialKeys.add(hunk.key);
      }
    }

    for (const hunk of batchHunks) {
      if (seenIds.has(hunk.id)) {
        continue;
      }
      this.logger.warn(
        { filePath: hunk.filePath, hunkId: hunk.id },
        "Triage response missing verdict for hunk, defaulting to needs-review",
      );
      seenIds.add(hunk.id);
      decisions.push({
        filePath: hunk.filePath,
        hunkHeader: hunk.header,
        verdict: "needs-review",
      });
    }

    return { parseFailed: false, trivialCount };
  }

  async execute(
    context: ReviewContext,
    _priorResults: Map<string, PassResult>,
  ): Promise<PassResult<TriagePassMetadata>> {
    const hunks = extractHunks(context.diffs);
    if (hunks.length === 0) {
      return {
        findings: [],
        metadata: emptyMetadata(),
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    const costBudget = context.costBudget;
    if (costBudget?.isExhausted()) {
      this.logger.warn(
        {
          limitUsd: costBudget.limit,
          mrIid: context.mrIid,
          projectId: context.projectId,
          reviewRunId: context.reviewRunId,
          spentUsd: costBudget.spent,
        },
        "Per-scan cost ceiling reached: skipping triage pass, every hunk stays eligible for review",
      );
      return {
        findings: [],
        metadata: emptyMetadata(),
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    const model = context.reviewConfig.models.triage;
    const systemPrompt = buildTriageSystemPrompt();

    const singleEstimate = this.estimateBatchPromptTokens(systemPrompt, hunks);

    const batches =
      singleEstimate <= TRIAGE_BATCH_PROMPT_TOKEN_BUDGET
        ? [hunks]
        : this.buildBatches(hunks, systemPrompt);

    const batchCount = batches.length;
    const batched = batchCount > 1;
    const fileCount = new Set(context.diffs.map((d) => d.newPath)).size;
    this.logger.info(
      {
        batchCount,
        batched,
        fileCount,
        hunkCount: hunks.length,
        model,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
        singleEstimate,
      },
      "Triage pass starting",
    );

    const hunkById = new Map(hunks.map((h) => [h.id, h]));
    let decisions: TriageDecision[] = [];
    const trivialKeys = new Set<string>();
    const seenIds = new Set<number>();
    let rawTrivialCount = 0;
    let parseFailures = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalEstimatedPromptTokens = 0;
    let costCeilingReported = false;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchHunks = batches[batchIndex]!;
      if (costBudget?.isExhausted()) {
        if (!costCeilingReported) {
          costCeilingReported = true;
          this.logger.warn(
            {
              batchIndex,
              limitUsd: costBudget.limit,
              mrIid: context.mrIid,
              projectId: context.projectId,
              remainingBatches: batches.length - batchIndex,
              reviewRunId: context.reviewRunId,
              spentUsd: costBudget.spent,
            },
            "Per-scan cost ceiling reached: skipping remaining triage batches, marking their hunks as needs-review",
          );
        }
        for (const hunk of batchHunks) {
          if (!seenIds.has(hunk.id)) {
            seenIds.add(hunk.id);
            decisions.push({
              filePath: hunk.filePath,
              hunkHeader: hunk.header,
              verdict: "needs-review",
            });
          }
        }
        continue;
      }
      const batchUserPrompt = buildTriageUserPrompt(
        batchHunks.map<TriageHunkInput>((h) => ({
          body: h.body,
          filePath: h.filePath,
          header: h.header,
          id: h.id,
        })),
      );
      const estimatedTokens = estimatePromptTokens([
        { content: systemPrompt, role: "system" },
        { content: batchUserPrompt, role: "user" },
      ]);
      totalEstimatedPromptTokens += estimatedTokens;
      const batchMaxTokens = Math.max(
        TRIAGE_MIN_MAX_TOKENS,
        batchHunks.length * TRIAGE_MAX_TOKENS_PER_HUNK,
      );

      this.logger.debug(
        { batchIndex, batchSize: batchHunks.length, estimatedTokens },
        "Triage batch starting",
      );

      try {
        const response = await this.llm.chatCompletion(
          [
            { content: systemPrompt, role: "system" },
            { content: batchUserPrompt, role: "user" },
          ],
          {
            maxPromptTokensHard: this.promptHardLimit,
            maxTokens: batchMaxTokens,
            model,
            responseSchema: TRIAGE_JSON_SCHEMA,
          },
        );
        totalPromptTokens += response.usage.promptTokens;
        totalCompletionTokens += response.usage.completionTokens;
        costBudget?.record(
          computeCostUsd(model, {
            inputTokens: response.usage.promptTokens,
            outputTokens: response.usage.completionTokens,
          }),
        );
        if (response.content === null) {
          this.logger.warn(
            { batchIndex, batchSize: batchHunks.length },
            "Triage batch returned null content, marking batch hunks as needs-review",
          );
          for (const hunk of batchHunks) {
            if (!seenIds.has(hunk.id)) {
              seenIds.add(hunk.id);
              decisions.push({
                filePath: hunk.filePath,
                hunkHeader: hunk.header,
                verdict: "needs-review",
              });
            }
          }
        } else {
          const trivialBeforeBatch = rawTrivialCount;
          const batchResult = this.processBatchResults(
            batchHunks,
            response.content,
            hunkById,
            decisions,
            trivialKeys,
            seenIds,
            {
              batchIndex,
              model,
              mrIid: context.mrIid,
              projectId: context.projectId,
              reviewRunId: context.reviewRunId,
            },
          );
          rawTrivialCount += batchResult.trivialCount;
          if (batchResult.parseFailed) parseFailures++;
          const trivialInBatch = rawTrivialCount - trivialBeforeBatch;
          this.logger.info(
            {
              batchIndex,
              batchSize: batchHunks.length,
              completionTokens: response.usage.completionTokens,
              costUsd: computeCostUsd(model, {
                inputTokens: response.usage.promptTokens,
                outputTokens: response.usage.completionTokens,
              }),
              model,
              mrIid: context.mrIid,
              projectId: context.projectId,
              promptTokens: response.usage.promptTokens,
              reviewRunId: context.reviewRunId,
              trivialInBatch,
            },
            "Triage batch completed",
          );
        }
      } catch (err) {
        this.logger.warn(
          { batchIndex, batchSize: batchHunks.length, err, model },
          "Triage batch LLM call failed, marking batch hunks as needs-review",
        );
        parseFailures++;
        for (const hunk of batchHunks) {
          if (!seenIds.has(hunk.id)) {
            seenIds.add(hunk.id);
            decisions.push({
              filePath: hunk.filePath,
              hunkHeader: hunk.header,
              verdict: "needs-review",
            });
          }
        }
      }
    }

    const capResult = applyConservativeCap(hunks, decisions, trivialKeys);
    decisions = capResult.decisions;
    const cappedTrivialKeys = capResult.trivialKeys;
    const trivialCount = cappedTrivialKeys.size;
    const triageSkipRate = hunks.length === 0 ? 0 : trivialCount / hunks.length;
    const avgBatchEstimatedTokens =
      batches.length === 0 ? 0 : totalEstimatedPromptTokens / batches.length;
    const totalSkipped =
      hunks.length -
      decisions.filter((d) => d.verdict === "needs-review").length;

    this.logger.info(
      {
        hunkCount: hunks.length,
        model,
        mrIid: context.mrIid,
        projectId: context.projectId,
        reviewRunId: context.reviewRunId,
        totalBatches: batches.length,
        totalEstimatedPromptTokens,
        totalHunks: hunks.length,
        totalSkipped,
        triageSkipRate,
        trivialCapDemotedCount: capResult.demotedTrivialCount,
        trivialCapMaxAllowedCount: capResult.maxAllowedTrivialCount,
        trivialCount,
      },
      "Triage completed",
    );

    const triageModel = context.reviewConfig.models.triage;
    return {
      findings: [],
      metadata: {
        avgBatchEstimatedTokens,
        decisions,
        parseFailures,
        totalBatches: batches.length,
        totalEstimatedPromptTokens,
        triageSkipRate,
        trivialHunkCount: trivialCount,
        trivialKeys: cappedTrivialKeys,
      },
      tokenUsage: {
        completionTokens: totalCompletionTokens,
        promptTokens: totalPromptTokens,
      },
      tokenUsageByModel: {
        [triageModel]: {
          completionTokens: totalCompletionTokens,
          promptTokens: totalPromptTokens,
        },
      },
    };
  }
}

export { applyTriageFilter, extractHunks, hunkKey, TriagePass };
export type { TriageDecision, TriagePassMetadata, TriageVerdict };
