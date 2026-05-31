import type { FastifyBaseLogger } from "fastify";

import { unresolveDiscussionsAfterFailedPersist } from "~/application/finding-addressed-sync.helper";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { PipelineConfig } from "~/config/pipeline.config";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ForcePushCorrelationResult } from "~/domain/types/force-push-correlation.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { ParsedFileDiff } from "~/review/diff-parser";
import { planForcePushLineCorrelation } from "~/review/force-push-line-match";

const FORCE_PUSH_ADDRESS_REPLY =
  "This concern was addressed or is no longer applicable after the force-push.";

class ForcePushCorrelationService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    InjectionTokens.PipelineConfig,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly pipelineConfig: PipelineConfig,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async execute(
    pendingFindings: ReviewFinding[],
    parsedDiffs: ParsedFileDiff[],
    projectId: number,
    mrIid: number,
  ): Promise<ForcePushCorrelationResult> {
    const lineMatchTabWidth =
      this.pipelineConfig.envs.FORCE_PUSH_LINE_MATCH_TAB_WIDTH;
    const lineWindow = this.pipelineConfig.envs.FORCE_PUSH_LINE_WINDOW;
    const plan = planForcePushLineCorrelation(pendingFindings, parsedDiffs, {
      lineMatchTabWidth,
      lineWindow,
    });
    const addressedFindingIds = await this.markAddressedMany(
      plan.findingsToMarkAddressed,
      projectId,
      mrIid,
    );
    const addressed: string[] = [];
    const pending = [...plan.pendingFindingIds];
    for (const finding of plan.findingsToMarkAddressed) {
      if (addressedFindingIds.has(finding.id)) {
        addressed.push(finding.id);
      } else {
        pending.push(finding.id);
      }
    }
    return {
      addressed,
      correlated: plan.correlated,
      pending,
    };
  }

  private async markAddressedMany(
    findings: readonly ReviewFinding[],
    projectId: number,
    mrIid: number,
  ): Promise<Set<string>> {
    if (findings.length === 0) {
      return new Set();
    }
    const resolvedFindings: ReviewFinding[] = [];
    for (const finding of findings) {
      if (!finding.hostDiscussionId) {
        continue;
      }
      try {
        await this.codeHost.replyToDiscussion(
          projectId,
          mrIid,
          finding.hostDiscussionId,
          FORCE_PUSH_ADDRESS_REPLY,
        );
        await this.codeHost.resolveDiscussion(
          projectId,
          mrIid,
          finding.hostDiscussionId,
        );
        resolvedFindings.push(finding);
      } catch (err) {
        this.logger.warn(
          { discussionId: finding.hostDiscussionId, err },
          "Failed to resolve discussion for finding after force-push; keeping pending",
        );
      }
    }
    const addressedIds = resolvedFindings.map((finding) => finding.id);
    if (addressedIds.length === 0) {
      return new Set();
    }
    try {
      await this.infraRepoPorts.reviewFindingRepo.updateResolutionMany(
        addressedIds,
        "addressed",
      );
    } catch (err) {
      const rollbackRefs = resolvedFindings
        .filter((f): f is ReviewFinding & { hostDiscussionId: string } =>
          Boolean(f.hostDiscussionId),
        )
        .map((f) => ({
          discussionId: f.hostDiscussionId,
          findingId: f.id,
        }));
      await unresolveDiscussionsAfterFailedPersist(
        {
          codeHost: this.codeHost,
          logger: this.logger,
          mrIid,
          projectId,
        },
        rollbackRefs,
      );
      this.logger.warn(
        { addressedIds, err },
        "Failed to mark findings as addressed; keeping pending",
      );
      return new Set();
    }
    return new Set(addressedIds);
  }
}

export { ForcePushCorrelationService };
