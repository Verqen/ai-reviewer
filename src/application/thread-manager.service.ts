import type { FastifyBaseLogger } from "fastify";

import { AnalyticsTokens } from "~/di/analytics.tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { IReviewService } from "~/review/review.types";

import type {
  ClassifiedIntent,
  ReviewLearningService,
} from "./review-learning.service";

interface HandleReplyInput {
  authorUsername: string;
  discussionId: string;
  mrIid: number;
  noteBody: string;
  projectId: number;
}

class ThreadManagerService {
  static inject = [
    AnalyticsTokens.ReviewFindingRepository,
    InjectionTokens.CodeHost,
    AnalyticsTokens.ReviewLearningService,
    ReviewTokens.ReviewService,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly reviewFindingRepo: IReviewFindingRepository,
    private readonly codeHost: ICodeHost,
    private readonly reviewLearningService: ReviewLearningService,
    private readonly reviewService: IReviewService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async handleReply(input: HandleReplyInput): Promise<void> {
    const { authorUsername, discussionId, mrIid, noteBody, projectId } = input;

    const findings = await this.reviewFindingRepo.findByProjectAndMr(
      projectId,
      mrIid,
    );

    const finding = findings.find(
      (currentFinding) =>
        currentFinding.hostDiscussionId === discussionId &&
        currentFinding.resolution === "pending",
    );

    if (!finding) {
      this.logger.info(
        { discussionId, mrIid, projectId },
        "Thread reply has no matching pending finding; ignoring (use @ai mention to invoke full review context)",
      );
      return;
    }

    const classifiedIntent = await this.reviewLearningService.classifyIntent(
      finding.comment,
      noteBody,
    );

    switch (classifiedIntent.intent) {
      case "false_positive":
        await this.resolveWithReply(
          projectId,
          mrIid,
          discussionId,
          finding,
          noteBody,
          authorUsername,
          classifiedIntent,
          "Understood, marking as false positive.",
        );
        break;

      case "accepted_debt":
        await this.resolveWithReply(
          projectId,
          mrIid,
          discussionId,
          finding,
          noteBody,
          authorUsername,
          classifiedIntent,
          "Acknowledged as accepted technical debt.",
        );
        break;

      case "dispute":
        await this.resolveWithReply(
          projectId,
          mrIid,
          discussionId,
          finding,
          noteBody,
          authorUsername,
          classifiedIntent,
          "Good point, resolving.",
        );
        break;

      case "agreement":
        this.logger.info(
          {
            discussionId,
            findingId: finding.id,
            intent: "agreement",
            mrIid,
            projectId,
          },
          "Developer agreed with finding; posting ack and resolving",
        );
        await this.ackAndResolve(
          projectId,
          mrIid,
          discussionId,
          "Acknowledged, thanks.",
        );
        break;

      case "clarification":
        await this.replyWithClarification(
          projectId,
          mrIid,
          discussionId,
          finding,
          noteBody,
        );
        break;
    }
  }

  private async ackAndResolve(
    projectId: number,
    mrIid: number,
    discussionId: string,
    ackText: string,
  ): Promise<void> {
    try {
      await this.codeHost.replyToDiscussion(
        projectId,
        mrIid,
        discussionId,
        ackText,
      );
    } catch (err) {
      this.logger.warn(
        { discussionId, err, mrIid, projectId },
        "Failed to post agreement ack reply",
      );
    }
    try {
      await this.codeHost.resolveDiscussion(projectId, mrIid, discussionId);
    } catch (err) {
      this.logger.warn(
        { discussionId, err, mrIid, projectId },
        "Failed to resolve discussion after agreement ack",
      );
    }
  }

  private async replyWithClarification(
    projectId: number,
    mrIid: number,
    discussionId: string,
    finding: ReviewFinding,
    devReply: string,
  ): Promise<void> {
    this.logger.info(
      {
        discussionId,
        findingId: finding.id,
        intent: "clarification",
        mrIid,
        projectId,
      },
      "Thread reply: generating clarification answer",
    );
    let answer: string;
    try {
      answer = await this.reviewService.respondToFindingThreadClarification(
        projectId,
        mrIid,
        finding,
        devReply,
      );
    } catch (err) {
      this.logger.warn(
        {
          discussionId,
          err,
          findingId: finding.id,
          intent: "clarification",
          mrIid,
          projectId,
        },
        "Failed to generate clarification answer; skipping reply",
      );
      return;
    }

    try {
      await this.codeHost.replyToDiscussion(
        projectId,
        mrIid,
        discussionId,
        answer,
      );
    } catch (err) {
      this.logger.warn(
        { discussionId, err, mrIid, projectId },
        "Failed to post clarification reply",
      );
    }
  }

  private async resolveWithReply(
    projectId: number,
    mrIid: number,
    discussionId: string,
    finding: ReviewFinding,
    devReply: string,
    authorUsername: string,
    classifiedIntent: ClassifiedIntent,
    botReply: string,
  ): Promise<void> {
    let isDiscussionResolved = false;
    try {
      await this.codeHost.replyToDiscussion(
        projectId,
        mrIid,
        discussionId,
        botReply,
      );
    } catch (err) {
      this.logger.warn(
        { discussionId, err },
        "Failed to post reply before resolving",
      );
    }

    try {
      await this.codeHost.resolveDiscussion(projectId, mrIid, discussionId);
      isDiscussionResolved = true;
    } catch (err) {
      this.logger.warn({ discussionId, err }, "Failed to resolve discussion");
    }

    try {
      await this.reviewLearningService.learnFromReply({
        authorUsername,
        classifiedIntent,
        devReply,
        finding,
        mrIid,
        projectId,
      });
    } catch (err) {
      if (isDiscussionResolved) {
        try {
          await this.codeHost.unresolveDiscussion(
            projectId,
            mrIid,
            discussionId,
          );
        } catch (rollbackErr) {
          this.logger.warn(
            { discussionId, err: rollbackErr, findingId: finding.id },
            "Failed to rollback discussion resolution after learning failure",
          );
        }
      }
      this.logger.warn(
        { err, findingId: finding.id },
        "Failed to record learning",
      );
    }
  }
}

export { ThreadManagerService };

export type { HandleReplyInput };
