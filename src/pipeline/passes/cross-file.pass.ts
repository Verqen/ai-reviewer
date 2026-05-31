import type { FastifyBaseLogger } from "fastify";
import { toJSONSchema, z } from "zod";

import { parseLlmJson } from "~/domain/llm/parse-llm-json";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type {
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding } from "~/domain/types/review.types";
import { PromptTokenBudgetExceededError } from "~/infrastructure/llm/estimate-prompt-tokens";
import {
  buildCrossFileSystemPrompt,
  buildCrossFileUserPrompt,
  type FileSummary,
} from "~/pipeline/prompts/cross-file.prompt";
import { resolveProjectAndPathRulesText } from "~/pipeline/prompts/resolve-path-rules";
import { formatParsedDiffForPromptWithBudget } from "~/review/diff-parser";
import { validateFindingPositionInHunk } from "~/review/finding-position-validation";

const CrossFileFindingSchema = z.object({
  category: z.string().default("architecture"),
  comment: z.string(),
  confidence: z.number().default(0.8),
  file_path: z.string(),
  line_number: z.number().int().default(1),
  line_type: z.enum(["added", "removed", "context"]).catch("added"),
  severity: z
    .enum(["critical", "attention", "warning", "info", "nitpick"])
    .catch("info"),
});

const CrossFileResponseSchema = z.object({
  findings: z.array(CrossFileFindingSchema),
});

const CROSS_FILE_JSON_SCHEMA = toJSONSchema(CrossFileResponseSchema);

const IN_DIFF_CONTEXT_BUDGET_CHARS = 6_000;
const CROSS_FILE_COMPACT_DIFF_BUDGET_CHARS = 10_000;
const CROSS_FILE_COMPACT_DIFF_MIN_ALLOC = 320;
const CROSS_FILE_MAX_TOKENS = 1200;
const CROSS_FILE_TEMPERATURE = 0.1;
const CROSS_FILE_MIN_FILES = 2;
const CROSS_FILE_MIN_DIFF_LINES = 120;

function buildFindingSummaries(priorFindings: Finding[]): string {
  if (priorFindings.length === 0) {
    return "";
  }

  const byFile = new Map<string, Finding[]>();

  for (const f of priorFindings) {
    const existing = byFile.get(f.filePath) ?? [];
    existing.push(f);
    byFile.set(f.filePath, existing);
  }

  const lines: string[] = [];

  for (const [file, findings] of byFile) {
    const summaries = findings
      .slice(0, 3)
      .map(
        (f) =>
          `  [${f.severity}/${f.category}] L${f.lineNumber}: ${f.comment.slice(0, 80)}`
      )
      .join("\n");
    lines.push(`${file}:\n${summaries}`);
  }

  return lines.join("\n\n");
}

async function gatherContext(
  diffs: readonly ParsedFileDiff[],
  overlayView: IOverlayView
): Promise<string> {
  if (diffs.length === 0) return "";
  const perFileBudget = Math.max(
    Math.floor(IN_DIFF_CONTEXT_BUDGET_CHARS / diffs.length),
    256
  );
  const sections: string[] = [];
  let totalChars = 0;
  for (const diff of diffs) {
    if (totalChars >= IN_DIFF_CONTEXT_BUDGET_CHARS) break;
    const content = await overlayView.readFile(diff.newPath);
    if (content.startsWith("File not found")) continue;
    const remainingGlobal = IN_DIFF_CONTEXT_BUDGET_CHARS - totalChars;
    const slice = content.slice(0, Math.min(perFileBudget, remainingGlobal));
    sections.push(`### ${diff.newPath}\n${slice}`);
    totalChars += slice.length;
  }
  return sections.join("\n\n");
}

function buildCompactMrDiffsSection(diffs: readonly ParsedFileDiff[]): {
  anchoredPaths: ReadonlySet<string>;
  omittedPaths: readonly string[];
  section: string;
} {
  const budget = CROSS_FILE_COMPACT_DIFF_BUDGET_CHARS;
  let used = 0;
  const anchoredPaths = new Set<string>();
  const parts: string[] = [];
  const omittedPaths: string[] = [];
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i]!;
    const remaining = budget - used;
    const filesRemaining = diffs.length - i;
    if (remaining < CROSS_FILE_COMPACT_DIFF_MIN_ALLOC) {
      omittedPaths.push(...diffs.slice(i).map((x) => x.newPath));
      break;
    }
    const alloc = Math.max(
      Math.floor(remaining / filesRemaining),
      CROSS_FILE_COMPACT_DIFF_MIN_ALLOC
    );
    const payload = formatParsedDiffForPromptWithBudget(d, {
      maxCharacters: Math.min(alloc, remaining),
      maxLines: 400,
    });
    const block = [
      `### ${d.newPath}`,
      "",
      payload.text,
      "",
      "Allowable anchors (each finding for this file MUST use exactly one pair from this table):",
      "",
      payload.allowableAnchorsText,
      "",
    ].join("\n");
    if (block.length > remaining) {
      omittedPaths.push(d.newPath);
      continue;
    }
    parts.push(block);
    used += block.length;
    anchoredPaths.add(d.newPath);
  }
  const body = parts.join("\n");
  const omittedNote =
    omittedPaths.length > 0
      ? `\n\n_Omitted from compact MR diffs (do NOT emit findings for these paths in this pass): ${omittedPaths.join(", ")}._`
      : "";
  const section = `## MR diffs (compact)\n\n${body}${omittedNote}`;
  return { anchoredPaths, omittedPaths, section };
}

class CrossFilePass implements IReviewPass {
  readonly name = "cross-file";

  constructor(
    private readonly llm: ILlmClient,
    private readonly logger: FastifyBaseLogger,
    private readonly promptHardLimit?: number
  ) {}

  async execute(
    context: ReviewContext,
    priorResults: Map<string, PassResult>
  ): Promise<PassResult> {
    const { diffs, mrInfo, reviewConfig } = context;

    const fileReviewResult = priorResults.get("file-review");
    const priorFindings = fileReviewResult?.findings ?? [];
    const totalDiffLines = diffs.reduce(
      (sum, diff) => sum + diff.lines.length,
      0
    );
    const hasElevatedRisk = priorFindings.some(
      (finding) =>
        finding.severity === "critical" || finding.severity === "attention"
    );
    if (
      diffs.length < CROSS_FILE_MIN_FILES ||
      (!hasElevatedRisk && totalDiffLines < CROSS_FILE_MIN_DIFF_LINES)
    ) {
      this.logger.info(
        {
          crossFileMinDiffLines: CROSS_FILE_MIN_DIFF_LINES,
          crossFileMinFiles: CROSS_FILE_MIN_FILES,
          diffFileCount: diffs.length,
          hasElevatedRisk,
          mrIid: context.mrIid,
          priorFindingsCount: priorFindings.length,
          projectId: context.projectId,
          reviewRunId: context.reviewRunId,
          skipped: "low_cross_file_risk",
          totalDiffLines,
        },
        "Cross-file pass skipped"
      );
      return {
        findings: [],
        metadata: { skipped: "low_cross_file_risk" },
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      };
    }

    const fileSummaries: FileSummary[] = diffs.map((d) => {
      const fileFindings = priorFindings.filter(
        (f) => f.filePath === d.newPath
      );
      const topSeverity =
        fileFindings.find((f) => f.severity === "critical")?.severity ??
        fileFindings.find((f) => f.severity === "attention")?.severity ??
        fileFindings.find((f) => f.severity === "warning")?.severity ??
        fileFindings[0]?.severity ??
        null;

      return {
        findingCount: fileFindings.length,
        path: d.newPath,
        topSeverity,
      };
    });

    const findingSummaries = buildFindingSummaries(priorFindings);

    const filePaths: string[] = diffs.map((d) => d.newPath);
    const { pathRules, projectRules } = resolveProjectAndPathRulesText({
      filePaths,
      pathRules: reviewConfig.pathRules ?? [],
    });
    const systemPrompt = buildCrossFileSystemPrompt(projectRules, pathRules);
    const { anchoredPaths, section: mrDiffsCompactSection } =
      buildCompactMrDiffsSection(diffs);
    const diffByPath = new Map(diffs.map((d) => [d.newPath, d]));

    try {
      let codebaseContext: string | undefined;
      if (context.overlayView) {
        codebaseContext = await gatherContext(diffs, context.overlayView);
      }

      const userPrompt = buildCrossFileUserPrompt(
        mrInfo,
        fileSummaries,
        findingSummaries,
        mrDiffsCompactSection,
        codebaseContext
      );

      this.logger.info(
        {
          contextChars: codebaseContext?.length ?? 0,
          fileSummariesCount: fileSummaries.length,
          model: reviewConfig.models.review,
          mrIid: context.mrIid,
          priorFindingsCount: priorFindings.length,
          projectId: context.projectId,
          reviewRunId: context.reviewRunId,
        },
        "Cross-file pass LLM call starting"
      );

      const response = await this.llm.chatCompletion(
        [
          { content: systemPrompt, role: "system" },
          { content: userPrompt, role: "user" },
        ],
        {
          maxPromptTokensHard: this.promptHardLimit,
          maxTokens: CROSS_FILE_MAX_TOKENS,
          model: reviewConfig.models.review,
          reasoning: { effort: "low" },
          responseSchema: CROSS_FILE_JSON_SCHEMA,
          temperature: CROSS_FILE_TEMPERATURE,
        }
      );

      const usageByReviewModel = {
        [reviewConfig.models.review]: {
          completionTokens: response.usage.completionTokens,
          promptTokens: response.usage.promptTokens,
        },
      };

      if (response.content === null) {
        this.logger.warn(
          { model: reviewConfig.models.review },
          "Cross-file review returned null content — skipping pass"
        );
        return {
          findings: [],
          metadata: {},
          tokenUsage: response.usage,
          tokenUsageByModel: usageByReviewModel,
        };
      }

      const raw: unknown = parseLlmJson(response.content);
      const parsed = CrossFileResponseSchema.safeParse(raw);

      if (!parsed.success) {
        this.logger.warn(
          {
            errors: parsed.error.issues.slice(0, 3),
            rawContent: String(response.content).slice(0, 500),
          },
          "Failed to parse cross-file response, skipping"
        );
        return {
          findings: [],
          metadata: {},
          tokenUsage: response.usage,
          tokenUsageByModel: usageByReviewModel,
        };
      }

      const allowedPaths = new Set(diffs.map((d) => d.newPath));
      const findings: Finding[] = parsed.data.findings
        .filter((item) => {
          if (allowedPaths.has(item.file_path)) return true;
          this.logger.warn(
            {
              mrIid: context.mrIid,
              off_diff_path: item.file_path,
              pass: "cross-file",
              projectId: context.projectId,
              reviewRunId: context.reviewRunId,
            },
            "Dropping off-diff finding"
          );
          return false;
        })
        .filter((item) => {
          if (anchoredPaths.has(item.file_path)) return true;
          this.logger.warn(
            {
              filePath: item.file_path,
              mrIid: context.mrIid,
              pass: "cross-file",
              projectId: context.projectId,
              reviewRunId: context.reviewRunId,
            },
            "Dropping finding: file not in compact MR diff section"
          );
          return false;
        })
        .filter((item) => {
          const fileDiff = diffByPath.get(item.file_path);
          if (!fileDiff) {
            return false;
          }
          const positionValidation = validateFindingPositionInHunk(
            item,
            fileDiff
          );
          if (positionValidation.valid) {
            return true;
          }
          this.logger.warn(
            {
              filePath: item.file_path,
              lineNumber: item.line_number,
              lineType: item.line_type,
              mrIid: context.mrIid,
              pass: "cross-file",
              projectId: context.projectId,
              reason: positionValidation.reason,
              reviewRunId: context.reviewRunId,
            },
            "Dropping off-hunk finding"
          );
          return false;
        })
        .map((item) => ({
          category: item.category,
          comment: item.comment,
          confidence: item.confidence,
          filePath: item.file_path,
          lineNumber: item.line_number,
          lineType: item.line_type,
          model: reviewConfig.models.review,
          passName: "cross-file",
          severity: item.severity,
        }));

      this.logger.info(
        {
          completionTokens: response.usage.completionTokens,
          findingsCount: findings.length,
          model: reviewConfig.models.review,
          mrIid: context.mrIid,
          projectId: context.projectId,
          promptTokens: response.usage.promptTokens,
          reviewRunId: context.reviewRunId,
        },
        "Cross-file pass completed"
      );

      return {
        findings,
        metadata: {},
        tokenUsage: response.usage,
        tokenUsageByModel: {
          [reviewConfig.models.review]: {
            completionTokens: response.usage.completionTokens,
            promptTokens: response.usage.promptTokens,
          },
        },
      };
    } catch (err) {
      if (err instanceof PromptTokenBudgetExceededError) {
        this.logger.warn(
          { estimatedTokens: err.estimatedTokens, hardLimit: err.hardLimit },
          "Cross-file pass skipped: prompt token hard limit exceeded"
        );
      } else {
        this.logger.warn({ err }, "Cross-file pass failed, skipping");
      }
      return {
        findings: [],
        metadata: {},
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      };
    }
  }
}

export { CrossFilePass };
