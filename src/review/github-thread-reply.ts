import type { FastifyBaseLogger } from "fastify";

import { GitHubConfig } from "~/config/github.config";
import { computeCostUsd } from "~/config/llm-pricing";
import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import { PipelineConfig } from "~/config/pipeline.config";
import { CostBudget } from "~/domain/cost-budget";
import type { LineType, Severity } from "~/domain/types/review.types";
import {
  createGitHubOctokit,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import { createSilentLogger } from "~/infrastructure/logging/silent-logger";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
import {
  buildFindingThreadClarificationSystemPrompt,
  buildFindingThreadClarificationUserPrompt,
} from "~/review/review-thread-clarification.prompt";

const REPLY_MAX_TOKENS = 700;
const REPLY_TEMPERATURE = 0.2;

export interface ReviewThreadFinding {
  filePath: string;
  line: number;
  lineType?: LineType;
  category?: string;
  severity?: Severity;
  comment: string;
  suggestion?: string | null;
}

export interface AnswerReviewThreadOptions {
  costBudget?: CostBudget | undefined;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  replyToCommentId: string;
  developerNote: string;
  finding: ReviewThreadFinding;
  installationId?: number | undefined;
  logger?: FastifyBaseLogger;
}

export interface AnswerReviewThreadResult {
  answer: string;
  posted: boolean;
  tokenCostUsd: number;
}

function defaultLogger(provided?: FastifyBaseLogger): FastifyBaseLogger {
  return provided ?? createSilentLogger();
}

export async function answerReviewThread(
  options: AnswerReviewThreadOptions,
): Promise<AnswerReviewThreadResult> {
  const { owner, repo, pullRequestNumber, replyToCommentId, finding } = options;
  const logger = defaultLogger(options.logger);
  const costBudget =
    options.costBudget ??
    new CostBudget(new PipelineConfig().envs.REVIEW_MAX_COST_USD);

  if (costBudget.isExhausted()) {
    logger.warn(
      {
        limitUsd: costBudget.limit,
        pullRequestNumber,
        spentUsd: costBudget.spent,
      },
      "Cost ceiling reached: skipping review thread reply",
    );
    return { answer: "", posted: false, tokenCostUsd: 0 };
  }

  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHost(octokit, githubConfig, logger);

  const repoMeta = await octokit.rest.repos.get({ owner, repo });
  const projectId = repoMeta.data.id;

  const mrInfo = await codeHost.getMergeRequestInfo(
    projectId,
    pullRequestNumber,
  );
  const diffFiles = await codeHost.getMergeRequestDiff(
    projectId,
    pullRequestNumber,
  );
  const fileDiff =
    diffFiles.find((file) => file.newPath === finding.filePath)?.diff ?? "";

  const llmConfig = new LlmConfig();
  let llm: OllamaClient | OpenRouterClient;
  let reviewModel: string;
  if (llmConfig.envs.LLM_PROVIDER === "ollama") {
    llm = new OllamaClient(llmConfig, logger);
    reviewModel = llmConfig.envs.OLLAMA_MODEL;
  } else {
    const openRouterConfig = new OpenRouterConfig();
    llm = new OpenRouterClient(openRouterConfig, logger);
    reviewModel = openRouterConfig.envs.OPENROUTER_MODEL;
  }

  const systemPrompt = buildFindingThreadClarificationSystemPrompt(null, null, {
    toolsAvailable: false,
  });
  const userPrompt = buildFindingThreadClarificationUserPrompt({
    developerNote: options.developerNote,
    diffText: fileDiff,
    finding: {
      category: finding.category ?? "best_practice",
      comment: finding.comment,
      confidence: 1,
      filePath: finding.filePath,
      id: replyToCommentId,
      lineNumber: finding.line,
      lineType: finding.lineType ?? "added",
      model: reviewModel,
      passName: "thread-reply",
      resolution: "pending",
      reviewRunId: "thread-reply",
      severity: finding.severity ?? "warning",
      suggestion: finding.suggestion ?? undefined,
    },
    mrInfo: {
      description: mrInfo.description,
      iid: pullRequestNumber,
      projectId,
      sourceBranch: mrInfo.sourceBranch,
      targetBranch: mrInfo.targetBranch,
      title: mrInfo.title,
    },
    threadSection: "",
  });

  const response = await llm.chatCompletion(
    [
      { content: systemPrompt, role: "system" },
      { content: userPrompt, role: "user" },
    ],
    {
      maxTokens: REPLY_MAX_TOKENS,
      model: reviewModel,
      temperature: REPLY_TEMPERATURE,
    },
  );

  const answer = response.content?.trim() ?? "";
  const tokenCostUsd = computeCostUsd(reviewModel, {
    inputTokens: response.usage.promptTokens,
    outputTokens: response.usage.completionTokens,
  });
  costBudget.record(tokenCostUsd);

  let posted = false;
  if (answer.length > 0) {
    await codeHost.replyToDiscussion(
      projectId,
      pullRequestNumber,
      replyToCommentId,
      answer,
    );
    posted = true;
  }

  return { answer, posted, tokenCostUsd };
}
