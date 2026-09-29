import type { FastifyBaseLogger } from "fastify";

import type { PipelineConfig } from "~/config/pipeline.config";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import {
  buildMentionReply,
  buildRuleThreadReply,
} from "~/domain/rule-catalog/thread-reply";
import type {
  CommentContext,
  ReviewFinding,
  TriggerType,
} from "~/domain/types/review.types";
import type { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { parseDiff } from "~/review/diff-parser";
import type { IReviewService } from "~/review/review.types";

class ReviewService implements IReviewService {
  static inject = [
    InjectionTokens.CodeHost,
    ReviewTokens.PipelineOrchestrator,
    InjectionTokens.PipelineConfig,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly codeHost: ICodeHost,
    private readonly orchestrator: PipelineOrchestrator,
    private readonly pipelineConfig: PipelineConfig,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async respondToComment(
    projectId: number,
    mrIid: number,
    context: CommentContext,
  ): Promise<void> {
    const reply = buildMentionReply(this.pipelineConfig.envs.RULE_CATALOG_URL);
    if (context.discussionId) {
      await this.codeHost.replyToDiscussion(
        projectId,
        mrIid,
        context.discussionId,
        reply,
      );
    } else {
      await this.codeHost.postNote(projectId, mrIid, reply);
    }
    this.logger.info({ mrIid, projectId }, "Response to @ai comment posted");
  }

  respondToFindingThreadClarification(
    _projectId: number,
    _mrIid: number,
    finding: ReviewFinding,
  ): Promise<string> {
    const rule =
      finding.ruleId === undefined
        ? undefined
        : findCatalogRule(finding.ruleId);
    return Promise.resolve(
      rule === undefined
        ? ""
        : buildRuleThreadReply(rule, this.pipelineConfig.envs.RULE_CATALOG_URL),
    );
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

    const parsedDiffs = diffs.map(parseDiff);

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
}

export { ReviewService };
