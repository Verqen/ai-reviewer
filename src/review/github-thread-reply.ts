import type { FastifyBaseLogger } from "fastify";

import { GitHubConfig } from "~/config/github.config";
import type { ProductNameOption } from "~/domain/product-name";
import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import { buildFindingThreadReply } from "~/domain/rule-catalog/thread-reply";
import {
  createGitHubOctokit,
  GitHubCodeHost,
} from "~/infrastructure/code-host/github/github.code-host";
import { createSilentLogger } from "~/infrastructure/logging/silent-logger";

export interface ReviewThreadFinding {
  filePath: string;
  line: number;
  ruleId: RuleId | null;
}

export interface AnswerReviewThreadOptions extends ProductNameOption {
  catalogUrl?: string | undefined;
  finding: ReviewThreadFinding;
  installationId?: number | undefined;
  logger?: FastifyBaseLogger;
  owner: string;
  pullRequestNumber: number;
  replyToCommentId: string;
  repo: string;
}

export interface AnswerReviewThreadResult {
  answer: string;
  posted: boolean;
}

export async function answerThreadWithCodeHost(
  codeHost: Pick<GitHubCodeHost, "getRepoId" | "replyToDiscussion">,
  options: Omit<AnswerReviewThreadOptions, "installationId" | "logger">,
): Promise<AnswerReviewThreadResult> {
  const answer = buildFindingThreadReply(
    options.finding.ruleId,
    options.catalogUrl,
    options.productName,
  );
  if (answer === "") return { answer, posted: false };
  const projectId = await codeHost.getRepoId(options.owner, options.repo);
  await codeHost.replyToDiscussion(
    projectId,
    options.pullRequestNumber,
    options.replyToCommentId,
    answer,
  );
  return { answer, posted: true };
}

export async function answerReviewThread(
  options: AnswerReviewThreadOptions,
): Promise<AnswerReviewThreadResult> {
  const logger = options.logger ?? createSilentLogger();
  const githubConfig = new GitHubConfig();
  const octokit = createGitHubOctokit(githubConfig, options.installationId);
  const codeHost = new GitHubCodeHost(octokit, githubConfig, logger);
  return answerThreadWithCodeHost(codeHost, options);
}
