import type { FastifyBaseLogger } from "fastify";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { readRuntimeEnv } from "~/config/runtime.env";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ReviewPipelineConfig } from "~/domain/types/config.types";
import type { Finding } from "~/domain/types/review.types";
import { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface TriageDegradation {
  model: string;
  parseFailures: number;
  totalBatches: number;
}

type CompleteSuccessfulRunParams = {
  allFindings: Finding[];
  baseSha: string;
  diffsFileCount: number;
  headSha: string;
  mrIid: number;
  postableFindings: Finding[];
  projectId: number;
  repostedFindings: Finding[];
  reviewConfig: ReviewPipelineConfig;
  reviewRunId: string;
  suppressedCount: number;
  tokenUsageByModel: Record<
    string,
    { completionTokens: number; promptTokens: number }
  >;
  totalCompletionTokens: number;
  totalPromptTokens: number;
  triageDegradation?: TriageDegradation | undefined;
};

function isTotalTriageFailure(d: TriageDegradation | undefined): boolean {
  return (
    d !== undefined && d.totalBatches > 0 && d.parseFailures === d.totalBatches
  );
}

interface BuildOverviewTextInput {
  allFindingsCount: number;
  postableFindingsCount: number;
  repostedFindingsCount: number;
  reviewRunId: string;
  triageDegradation: TriageDegradation | undefined;
}

function buildOverviewText(input: BuildOverviewTextInput): string {
  const repostedSuffix =
    input.repostedFindingsCount > 0
      ? `, ${input.repostedFindingsCount} repositioned after force-push`
      : "";
  if (isTotalTriageFailure(input.triageDegradation)) {
    const d = input.triageDegradation!;
    const prefix = `⚠ AI review degraded: triage parser failed on ${d.parseFailures}/${d.totalBatches} batches (model=${d.model})`;
    const suffix = ` See logs reviewRunId=${input.reviewRunId}.`;
    if (input.allFindingsCount === 0) {
      return `${prefix}; file-review found no issues.${suffix}`;
    }
    return `${prefix}. ${input.allFindingsCount} finding(s), ${input.postableFindingsCount} posted inline${repostedSuffix}.${suffix}`;
  }
  if (input.allFindingsCount === 0) {
    return "AI review complete — no issues found.";
  }
  return `AI review complete: ${input.allFindingsCount} finding(s), ${input.postableFindingsCount} posted inline${repostedSuffix}.`;
}

class ReviewRunCompletionService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    InjectionTokens.Cache,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly cache: ICache<boolean>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async completeSuccessfulRun(
    params: CompleteSuccessfulRunParams,
  ): Promise<void> {
    const {
      allFindings,
      baseSha,
      diffsFileCount,
      headSha,
      mrIid,
      postableFindings,
      projectId,
      repostedFindings,
      reviewConfig,
      reviewRunId,
      suppressedCount,
      tokenUsageByModel,
      totalCompletionTokens,
      totalPromptTokens,
      triageDegradation,
    } = params;
    const overviewText = buildOverviewText({
      allFindingsCount: allFindings.length,
      postableFindingsCount: postableFindings.length,
      repostedFindingsCount: repostedFindings.length,
      reviewRunId,
      triageDegradation,
    });
    const summaryNote = buildSummaryNote({
      allFindings,
      includeCostFooter: readRuntimeEnv().SHOW_REVIEW_COST_FOOTER,
      overview: overviewText,
      postableFindings,
      suppressedCount,
      tokenUsageByModel,
    });

    const now = new Date();

    await this.infraRepoPorts.reviewRunRepo.completeRun(reviewRunId, {
      baseCommitSha: baseSha,
      stats: {
        completionTokens: totalCompletionTokens,
        configSnapshot: {
          models: {
            premium: reviewConfig.models.premium ?? null,
            review: reviewConfig.models.review,
            triage: reviewConfig.models.triage,
          },
          pathRulesCount: reviewConfig.pathRules.length,
          rulesSource: reviewConfig.rulesSource ?? "REVIEW.md (local)",
          severityThreshold: reviewConfig.severityThreshold,
        },
        criticalCount: allFindings.filter((f) => f.severity === "critical")
          .length,
        filesReviewed: diffsFileCount,
        promptTokens: totalPromptTokens,
        reviewModel: reviewConfig.models.review,
        totalFindings: allFindings.length,
        warningCount: allFindings.filter((f) => f.severity === "warning")
          .length,
      },
      timestamp: now,
    });

    await this.codeHost.postNote(projectId, mrIid, summaryNote);

    await this.applyAutoApproval(
      projectId,
      mrIid,
      allFindings,
      reviewConfig.blockMergeOn,
    );
    this.cache.set(
      `review:${projectId}:${mrIid}:${headSha}`,
      true,
      SEVEN_DAYS_MS,
    );
    this.logger.info(
      {
        allFindings: allFindings.length,
        mrIid,
        posted: postableFindings.length,
        projectId,
        suppressedCount,
      },
      "MR review completed",
    );
  }

  private async applyAutoApproval(
    projectId: number,
    mrIid: number,
    findings: Finding[],
    blockMergeOn: "critical" | "warning" | "none",
  ): Promise<void> {
    if (blockMergeOn === "none") {
      return;
    }
    const criticalCount = findings.filter(
      (f) => f.severity === "critical",
    ).length;
    const warningCount = findings.filter(
      (f) => f.severity === "warning",
    ).length;
    const shouldBlock =
      blockMergeOn === "critical"
        ? criticalCount > 0
        : criticalCount > 0 || warningCount > 0;
    if (shouldBlock) {
      try {
        await this.codeHost.unapprove(projectId, mrIid);
        this.logger.info(
          { blockMergeOn, criticalCount, mrIid, projectId, warningCount },
          "Unapproved MR due to findings exceeding threshold",
        );
      } catch (err) {
        this.logger.warn({ err, mrIid, projectId }, "Failed to unapprove MR");
      }
    } else {
      try {
        await this.codeHost.approveMergeRequest(projectId, mrIid);
        this.logger.info(
          { blockMergeOn, mrIid, projectId },
          "Auto-approved MR: no blocking findings",
        );
      } catch (err) {
        this.logger.warn(
          { err, mrIid, projectId },
          "Failed to auto-approve MR",
        );
      }
    }
  }
}

export type { CompleteSuccessfulRunParams, TriageDegradation };
export { buildOverviewText };
export { ReviewRunCompletionService };
