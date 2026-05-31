import type { FastifyBaseLogger } from "fastify";
import { toJSONSchema, z } from "zod";

import { AnalyticsTokens } from "~/di/analytics.tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import { parseLlmJson } from "~/domain/llm/parse-llm-json";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ChatMessage } from "~/domain/types/llm.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import { runNarrowFindingClarification } from "~/review/review-narrow-finding-clarification";

const IntentResponseSchema = z.object({
  intent: z.enum([
    "false_positive",
    "accepted_debt",
    "clarification",
    "agreement",
    "dispute",
  ]),
  reason: z.string(),
});

type ReplyIntent = z.infer<typeof IntentResponseSchema>["intent"];

interface ClassifiedIntent {
  intent: ReplyIntent;
  reason: string;
}

const INTENT_JSON_SCHEMA = toJSONSchema(IntentResponseSchema);
const INTENT_CLASSIFICATION_MAX_TOKENS = 220;
const INTENT_CLASSIFICATION_TEMPERATURE = 0;
const PATTERN_SUMMARY_MAX_TOKENS = 140;
const THREAD_REPLY_PROMPT_TOKEN_HARD_LIMIT = 6_000;

interface LearnFromReplyInput {
  authorUsername: string;
  classifiedIntent?: ClassifiedIntent | undefined;
  devReply: string;
  finding: ReviewFinding;
  mrIid: number;
  projectId: number;
}

class ReviewLearningService {
  static inject = [
    AnalyticsTokens.DismissedPatternRepository,
    AnalyticsTokens.ReviewFindingRepository,
    InjectionTokens.Llm,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly dismissedPatternRepo: IDismissedPatternRepository,
    private readonly reviewFindingRepo: IReviewFindingRepository,
    private readonly llm: ILlmClient,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async classifyIntent(
    botComment: string,
    devReply: string,
  ): Promise<ClassifiedIntent> {
    const systemPrompt = [
      "You classify one developer reply to an automated code-review comment into exactly ONE intent.",
      "",
      "DECISION ORDER (first matching step wins; then refine using intent definitions below):",
      "1) Question, uncertainty, or any ask for help: wording like how/what/why, or requests for a fix, patch, example, rewrite, suggestion, or explanation → clarification.",
      "2) Else explicit deferral: acknowledges the issue but intentionally ships it as debt (later, another MR, backlog) → accepted_debt.",
      "3) Else denies the issue on substance: not a bug, intentional as-is, reviewer misread — without citing an external rule that overrides the comment → false_positive.",
      "4) Else cites authority: ticket, spec, ADR, convention, prior team decision — arguing the comment does not apply → dispute.",
      "5) Else plain commitment to fix with no ask → agreement.",
      "6) If still ambiguous → clarification.",
      "",
      "CONTRASTS:",
      "- false_positive: no real problem; reviewer wrong about the facts.",
      "- dispute: may disagree with the reviewer using documented or agreed team norms.",
      "- accepted_debt: problem accepted as real but intentionally not fixed in this change.",
      "",
      "INTENTS:",
      "- clarification: needs more information or concrete help. Examples: 'how to fix?', 'what do you mean?', 'предложи исправление', 'show the code', 'why is this wrong?', 'что лучше использовать?'.",
      "- agreement: acknowledges the finding and will fix; no question or request mixed in. Examples: 'agreed, fixing', 'good catch, will update', 'согласен, поправлю', 'ок, исправлю', 'LGTM, will patch'.",
      "- false_positive: claims not an issue / intentional behavior / reviewer mistake (see contrast with dispute).",
      "- accepted_debt: acknowledges issue but explicitly defers (see decision step 2).",
      "- dispute: counter-argument grounded in spec, ticket, or convention.",
      "",
      "COUNTEREXAMPLES:",
      "- 'Agreed, but how should I fix it?' → clarification (question/ask present).",
      "- 'LGTM' or 'will fix' with no question → agreement.",
      "",
      "FIELD reason: one short English phrase stating why this intent fits; do not paste the full developer reply.",
      "",
      "HARD RULES:",
      "- Any request for a fix, code, suggestion, example, or explanation is clarification, never agreement.",
      "- agreement requires explicit acknowledgement and zero questions or requests.",
      "- When torn between clarification and any other intent, choose clarification.",
      "- Output JSON only per schema. No prose.",
    ].join("\n");

    const userPrompt = [
      `Reviewer comment:`,
      `"${botComment}"`,
      ``,
      `Developer reply:`,
      `"${devReply}"`,
    ].join("\n");

    const messages: ChatMessage[] = [
      { content: [{ text: systemPrompt, type: "text" }], role: "system" },
      { content: userPrompt, role: "user" },
    ];

    const response = await this.llm.chatCompletion(messages, {
      maxPromptTokensHard: THREAD_REPLY_PROMPT_TOKEN_HARD_LIMIT,
      maxTokens: INTENT_CLASSIFICATION_MAX_TOKENS,
      reasoning: { effort: "low" },
      responseSchema: INTENT_JSON_SCHEMA,
      temperature: INTENT_CLASSIFICATION_TEMPERATURE,
    });

    const rawUnknown = parseLlmJson(response.content);
    const parsed = IntentResponseSchema.safeParse(rawUnknown);
    const intent: ReplyIntent = parsed.success
      ? parsed.data.intent
      : "clarification";
    const reason = parsed.success ? parsed.data.reason : "";
    const rawIntent =
      typeof rawUnknown === "object" &&
      rawUnknown !== null &&
      "intent" in rawUnknown
        ? rawUnknown.intent
        : undefined;
    this.logger.info(
      { intent, rawIntent, reason },
      "Thread reply intent classified",
    );
    return { intent, reason };
  }

  async answerClarification(
    finding: ReviewFinding,
    devReply: string,
  ): Promise<string> {
    return runNarrowFindingClarification(this.llm, finding, devReply);
  }

  async learnFromReply(input: LearnFromReplyInput): Promise<void> {
    const { authorUsername, devReply, finding, projectId } = input;

    const classified =
      input.classifiedIntent ??
      (await this.classifyIntent(finding.comment, devReply));

    if (
      classified.intent !== "false_positive" &&
      classified.intent !== "accepted_debt" &&
      classified.intent !== "dispute"
    ) {
      return;
    }

    const existing = await this.dismissedPatternRepo.findSimilar(
      projectId,
      finding.category,
      finding.comment,
    );

    if (existing) {
      await this.dismissedPatternRepo.incrementOccurrence(existing.id);
      this.logger.info(
        { patternId: existing.id, projectId },
        "Incremented dismissed pattern occurrence",
      );
    } else {
      const patternDescription = await this.generatePatternDescription(
        finding.comment,
        devReply,
      );
      await this.dismissedPatternRepo.create({
        category: finding.category,
        createdBy: authorUsername,
        patternDescription,
        projectId,
        sampleComment: finding.comment,
        sampleReply: devReply,
        severity: finding.severity,
      });
      this.logger.info(
        { category: finding.category, projectId },
        "Created new dismissed pattern",
      );
    }

    await this.reviewFindingRepo.updateResolution(
      finding.id,
      classified.intent === "false_positive" ? "dismissed" : "wont_fix",
      authorUsername,
      classified.reason,
    );
  }

  private async generatePatternDescription(
    botComment: string,
    devReply: string,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        content: `Summarize in one sentence what type of code review comment the developer dismissed. Bot comment: "${botComment}". Developer reply: "${devReply}". Respond with just the summary sentence.`,
        role: "user",
      },
    ];

    const response = await this.llm.chatCompletion(messages, {
      maxPromptTokensHard: THREAD_REPLY_PROMPT_TOKEN_HARD_LIMIT,
      maxTokens: PATTERN_SUMMARY_MAX_TOKENS,
      reasoning: { effort: "low" },
      temperature: 0.1,
    });
    return response.content?.trim() ?? botComment.slice(0, 200);
  }
}

export { ReviewLearningService };

export type { ClassifiedIntent, LearnFromReplyInput, ReplyIntent };
