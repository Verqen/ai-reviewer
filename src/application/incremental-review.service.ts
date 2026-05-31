import type { FastifyBaseLogger } from "fastify";

import type { ForcePushCorrelationService } from "~/application/force-push-correlation.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { DiffFile } from "~/domain/types/code-host.types";
import type {
  ForcePushLikeTriggerType,
  IncrementalTriggerType,
} from "~/domain/types/review.types";
import type { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";
import { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";
import type { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import { parseDiff } from "~/review/diff-parser";
import { scopeDeltaDiffsToMrHunks } from "~/review/incremental-hunk-scope";

interface IncrementalJob {
  mrIid: number;
  newHeadSha: string;
  previousSha: string;
  projectId: number;
  triggerType: IncrementalTriggerType;
}

class IncrementalReviewService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    ReviewTokens.PipelineOrchestrator,
    InjectionTokens.Logger,
    ReviewTokens.ForcePushCorrelationService,
    InjectionTokens.PipelineMetrics,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly orchestrator: PipelineOrchestrator,
    private readonly logger: FastifyBaseLogger,
    private readonly forcePushCorrelationService: ForcePushCorrelationService,
    private readonly metrics: PipelineMetrics,
  ) {}

  async run(job: IncrementalJob): Promise<void> {
    const { mrIid, newHeadSha, previousSha, projectId, triggerType } = job;
    const previousRun =
      await this.infraRepoPorts.reviewRunRepo.findLatestByProjectAndMr(
        projectId,
        mrIid,
        undefined,
        { includeFailedForBaseline: true },
      );
    if (triggerType === "push") {
      await this.runNormalPush(
        projectId,
        mrIid,
        previousSha,
        newHeadSha,
        previousRun?.id,
      );
    } else {
      await this.runForcePush(
        projectId,
        mrIid,
        previousSha,
        newHeadSha,
        previousRun?.id,
        triggerType,
      );
    }
  }

  async runMainPushScopedReview(params: {
    changedFiles: readonly string[];
    mrIid: number;
    previousRunId: string;
    projectId: number;
  }): Promise<void> {
    const { changedFiles, mrIid, previousRunId, projectId } = params;
    this.logger.info(
      { mrIid, projectId },
      "Running main-push scoped incremental review",
    );
    const allowlist = new Set(changedFiles);
    const [mrDiffs, versions] = await Promise.all([
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);
    const scopedRaw = mrDiffs.filter(
      (d) =>
        allowlist.has(d.newPath) ||
        (d.oldPath.length > 0 && allowlist.has(d.oldPath)),
    );
    const reviewable = this.applySkipFilter(scopedRaw);
    if (reviewable.length === 0) {
      this.logger.info(
        { mrIid, projectId },
        "No reviewable scoped changes after main push; skipping",
      );
      return;
    }
    const parsedDiffs = reviewable.map(parseDiff);
    await this.orchestrator.run({
      diffs: parsedDiffs,
      isIncremental: true,
      mrIid,
      previousRunId,
      projectId,
      triggerType: "main_push",
      versions,
    });
  }

  private applySkipFilter(diffs: DiffFile[]): DiffFile[] {
    const reviewable: DiffFile[] = [];
    for (const diff of diffs) {
      const reason = getPrimarySkipReason(diff.newPath);
      if (reason === null) {
        reviewable.push(diff);
        continue;
      }
      this.metrics.observeFileSkipped(reason);
    }
    return reviewable;
  }

  private buildMrPathAllowlist(mrDiffs: readonly DiffFile[]): Set<string> {
    const allowlist = new Set<string>();
    for (const mrDiff of mrDiffs) {
      if (mrDiff.newPath.length > 0) {
        allowlist.add(mrDiff.newPath);
      }
      if (mrDiff.oldPath.length > 0) {
        allowlist.add(mrDiff.oldPath);
      }
    }
    return allowlist;
  }

  private applyMrFileAllowlist(
    deltaDiffs: readonly DiffFile[],
    allowlist: ReadonlySet<string>,
  ): DiffFile[] {
    return deltaDiffs.filter(
      (deltaDiff) =>
        (deltaDiff.newPath.length > 0 && allowlist.has(deltaDiff.newPath)) ||
        (deltaDiff.oldPath.length > 0 && allowlist.has(deltaDiff.oldPath)),
    );
  }

  private buildContextChangedPathsFromMrDiff(
    mrDiffs: readonly DiffFile[],
  ): string[] {
    const contextPaths = new Set<string>();
    for (const mrDiff of mrDiffs) {
      if (mrDiff.newPath.length > 0) {
        contextPaths.add(mrDiff.newPath);
      }
      if (mrDiff.oldPath.length > 0) {
        contextPaths.add(mrDiff.oldPath);
      }
    }
    return [...contextPaths];
  }

  private async runNormalPush(
    projectId: number,
    mrIid: number,
    previousSha: string,
    newHeadSha: string,
    previousRunId: string | undefined,
  ): Promise<void> {
    this.logger.info(
      { from: previousSha, mrIid, projectId, to: newHeadSha },
      "Running incremental review (normal push)",
    );
    const [deltaDiffs, mrDiffs, versions] = await Promise.all([
      this.codeHost.getCommitRangeDiff(projectId, previousSha, newHeadSha, {
        straight: true,
      }),
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);
    const mrPathAllowlist = this.buildMrPathAllowlist(mrDiffs);
    const allowlistedDeltaDiffs = this.applyMrFileAllowlist(
      deltaDiffs,
      mrPathAllowlist,
    );
    const scopedDeltaDiffs = scopeDeltaDiffsToMrHunks(
      allowlistedDeltaDiffs,
      mrDiffs,
    );
    const reviewable = this.applySkipFilter(scopedDeltaDiffs);
    if (reviewable.length === 0) {
      this.logger.info(
        { mrIid, projectId },
        "No reviewable changes in delta; skipping",
      );
      await this.codeHost.postNote(
        projectId,
        mrIid,
        "No new reviewable changes to review.",
      );
      return;
    }
    const parsedDiffs = reviewable.map(parseDiff);
    const contextChangedPaths =
      this.buildContextChangedPathsFromMrDiff(mrDiffs);
    await this.orchestrator.run({
      contextChangedPaths,
      diffs: parsedDiffs,
      isIncremental: true,
      mrIid,
      previousRunId,
      projectId,
      triggerType: "push",
      versions,
    });
  }

  private async runForcePush(
    projectId: number,
    mrIid: number,
    _previousSha: string,
    newHeadSha: string,
    previousRunId: string | undefined,
    triggerType: ForcePushLikeTriggerType,
  ): Promise<void> {
    this.logger.info(
      { mrIid, newHeadSha, projectId, triggerType },
      "Running force-push review scoped to current MR diff",
    );
    await this.runForcePushFromFullMrDiff(
      projectId,
      mrIid,
      previousRunId,
      triggerType,
    );
  }

  private async runForcePushFromFullMrDiff(
    projectId: number,
    mrIid: number,
    previousRunId: string | undefined,
    triggerType: ForcePushLikeTriggerType,
  ): Promise<void> {
    const [fullDiffs, versions] = await Promise.all([
      this.codeHost.getMergeRequestDiff(projectId, mrIid),
      this.codeHost.getMergeRequestVersions(projectId, mrIid),
    ]);
    const contextChangedPaths =
      this.buildContextChangedPathsFromMrDiff(fullDiffs);
    const reviewable = this.applySkipFilter(fullDiffs);
    const parsedDiffs = reviewable.map(parseDiff);
    if (previousRunId) {
      const previousFindings =
        await this.infraRepoPorts.reviewFindingRepo.findByRunId(previousRunId);
      const pendingFindings = previousFindings.filter(
        (f) => f.resolution === "pending",
      );
      const forcePushCorrelation =
        await this.forcePushCorrelationService.execute(
          pendingFindings,
          parsedDiffs,
          projectId,
          mrIid,
        );
      await this.orchestrator.run({
        contextChangedPaths,
        diffs: parsedDiffs,
        forcePushCorrelation,
        isIncremental: true,
        mrIid,
        previousRunId,
        projectId,
        triggerType,
        versions,
      });
      return;
    }
    await this.orchestrator.run({
      contextChangedPaths,
      diffs: parsedDiffs,
      isIncremental: true,
      mrIid,
      previousRunId,
      projectId,
      triggerType,
      versions,
    });
  }
}

export { IncrementalReviewService };
export type { IncrementalJob };
