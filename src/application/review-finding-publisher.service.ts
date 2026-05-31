import type { FastifyBaseLogger } from "fastify";

import type { CommentResolutionService } from "~/application/comment-resolution.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { VersionInfo } from "~/domain/types/code-host.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ForcePushCorrelationCandidate } from "~/domain/types/force-push-correlation.types";
import type { Finding, TriggerType } from "~/domain/types/review.types";
import { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
import {
  buildPosition,
  originalSnippetMatchesDiff,
} from "~/review/finding-inline-position";
import { validateMissingImportFinding } from "~/review/import-path-existence-validator";
import { sanitizeSuggestionAndComment } from "~/review/suggestion-sanitizer";

type PublishInlineParams = {
  allFindings: Finding[];
  diffs: ParsedFileDiff[];
  mrIid: number;
  postableFindings: Finding[];
  projectId: number;
  reviewRunId: string;
  versions: VersionInfo;
};

type RepostCorrelatedParams = {
  correlated: ForcePushCorrelationCandidate[];
  mrIid: number;
  projectId: number;
  reviewRunId: string;
  versions: VersionInfo;
};

type ResolveIncrementalParams = {
  diffs: ParsedFileDiff[];
  isIncremental: boolean;
  mrIid: number;
  previousRunId: string | undefined;
  projectId: number;
  triggerType: TriggerType;
};

function isPositionIncludedInDiffs(
  position: {
    newLine?: number | undefined;
    newPath: string;
    oldLine?: number | undefined;
    oldPath: string;
  },
  diffs: ParsedFileDiff[],
): boolean {
  const fileDiff = diffs.find(
    (diff) =>
      diff.newPath === position.newPath ||
      diff.newPath === position.oldPath ||
      diff.oldPath === position.newPath ||
      diff.oldPath === position.oldPath,
  );
  if (!fileDiff) {
    return false;
  }
  return fileDiff.lines.some(
    (line) =>
      (position.newLine !== undefined && line.newLine === position.newLine) ||
      (position.oldLine !== undefined && line.oldLine === position.oldLine),
  );
}

/**
 * Posts inline comments to the code host, persists findings, reposts after force-push correlation, and resolves stale incremental threads.
 */
class ReviewFindingPublisherService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.CodeHost,
    ReviewTokens.CommentResolutionService,
    InjectionTokens.Logger,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly commentResolutionService: CommentResolutionService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async publishInlineFindingsAndStore(
    params: PublishInlineParams,
  ): Promise<void> {
    const {
      allFindings,
      diffs,
      mrIid,
      postableFindings,
      projectId,
      reviewRunId,
      versions,
    } = params;
    const findingsToPersist: Array<
      Finding & {
        hostDiscussionId?: string;
        hostNoteId?: string;
        reviewRunId: string;
      }
    > = [];
    for (const finding of postableFindings) {
      const missingImportValidation = await validateMissingImportFinding({
        codeHost: this.codeHost,
        finding,
        headSha: versions.headSha,
        projectId,
      });
      if (missingImportValidation.shouldDrop) {
        this.logger.info(
          {
            extractedPath: missingImportValidation.extractedPath,
            filePath: finding.filePath,
            reason: missingImportValidation.reason,
            resolvedPath: missingImportValidation.resolvedPath,
          },
          "Dropping missing-file finding after deterministic validation",
        );
        continue;
      }
      const positionResult = buildPosition(finding, versions, diffs);
      if (!positionResult) {
        this.logger.warn(
          { file: finding.filePath, line: finding.lineNumber },
          "Skipping comment with invalid position",
        );
        findingsToPersist.push({ ...finding, reviewRunId });
        continue;
      }
      const { position } = positionResult;
      if (!isPositionIncludedInDiffs(position, diffs)) {
        this.logger.warn(
          {
            file: finding.filePath,
            line: finding.lineNumber,
            positionNewLine: position.newLine,
            positionOldLine: position.oldLine,
          },
          "Skipping comment with out-of-scope position",
        );
        findingsToPersist.push({ ...finding, reviewRunId });
        continue;
      }
      try {
        const sanitized = sanitizeSuggestionAndComment({
          comment: finding.comment,
          suggestion: finding.suggestion,
        });
        const snippetMatchesDiff =
          sanitized.suggestion !== undefined && finding.originalSnippet
            ? originalSnippetMatchesDiff(
                finding.originalSnippet,
                finding,
                diffs,
              )
            : false;
        const commentBody = formatCommentWithSuggestion(
          sanitized.comment,
          finding.severity,
          snippetMatchesDiff ? sanitized.suggestion : undefined,
          snippetMatchesDiff ? finding.originalSnippet : undefined,
          finding.lineType,
          position.newLine ?? finding.lineNumber,
          finding.endLineNumber,
        );
        const { discussionId, noteId } = await this.codeHost.postInlineComment(
          projectId,
          mrIid,
          commentBody,
          position,
        );
        findingsToPersist.push({
          ...finding,
          hostDiscussionId: discussionId,
          hostNoteId: noteId,
          reviewRunId,
        });
      } catch (err) {
        this.logger.error(
          { err, file: finding.filePath, line: finding.lineNumber },
          "Failed to post inline comment",
        );
        findingsToPersist.push({ ...finding, reviewRunId });
      }
    }
    const unpublishedFindings = allFindings
      .filter((f) => !postableFindings.includes(f))
      .map((f) => ({ ...f, reviewRunId }));
    const allFindingsToStore = [...findingsToPersist, ...unpublishedFindings];
    if (allFindingsToStore.length > 0) {
      await this.infraRepoPorts.reviewFindingRepo.createMany(
        allFindingsToStore,
      );
    }
  }

  async repostCorrelatedFindings(
    params: RepostCorrelatedParams,
  ): Promise<void> {
    const { correlated, mrIid, projectId, reviewRunId, versions } = params;
    const addressedFindingIds: string[] = [];
    for (const candidate of correlated) {
      const { finding, newLineNumber } = candidate;
      this.logger.info(
        { filePath: finding.filePath, findingId: finding.id, newLineNumber },
        "Correlated finding after force-push; reposting at new position",
      );
      try {
        const sanitized = sanitizeSuggestionAndComment({
          comment: finding.comment,
          suggestion: finding.suggestion,
        });
        const commentBody = formatCommentWithSuggestion(
          sanitized.comment,
          finding.severity,
          sanitized.suggestion,
          finding.originalSnippet,
          finding.lineType,
          newLineNumber,
          finding.endLineNumber,
        );
        const { discussionId, noteId } = await this.codeHost.postInlineComment(
          projectId,
          mrIid,
          commentBody,
          {
            baseSha: versions.baseSha,
            headSha: versions.headSha,
            newLine: newLineNumber,
            newPath: finding.filePath,
            oldPath: finding.oldPath ?? finding.filePath,
            positionType: "text",
            startSha: versions.startSha,
          },
        );
        await this.infraRepoPorts.reviewFindingRepo.createMany([
          {
            ...finding,
            hostDiscussionId: discussionId,
            hostNoteId: noteId,
            lineNumber: newLineNumber,
            reviewRunId,
          },
        ]);
        addressedFindingIds.push(finding.id);
      } catch (err) {
        this.logger.warn(
          { err, filePath: finding.filePath, findingId: finding.id },
          "Failed to repost finding at new position after force-push",
        );
        continue;
      }
      try {
        await this.codeHost.replyToDiscussion(
          projectId,
          mrIid,
          finding.hostDiscussionId!,
          "Moved to new position after force-push.",
        );
        await this.codeHost.resolveDiscussion(
          projectId,
          mrIid,
          finding.hostDiscussionId!,
        );
      } catch (err) {
        this.logger.warn(
          { discussionId: finding.hostDiscussionId, err },
          "Failed to annotate old discussion after force-push correlation",
        );
      }
    }
    if (addressedFindingIds.length > 0) {
      await this.infraRepoPorts.reviewFindingRepo.updateResolutionMany(
        [...new Set(addressedFindingIds)],
        "addressed",
      );
    }
  }

  async resolveStaleIncrementalFindings(
    params: ResolveIncrementalParams,
  ): Promise<void> {
    const {
      diffs,
      isIncremental,
      mrIid,
      previousRunId,
      projectId,
      triggerType,
    } = params;
    const isPushLike = triggerType === "push" || triggerType === "main_push";
    if (!isIncremental || !previousRunId || !isPushLike) {
      return;
    }
    const previousFindings =
      await this.infraRepoPorts.reviewFindingRepo.findByRunId(previousRunId);
    const pendingFindings = previousFindings.filter(
      (f) => f.resolution === "pending",
    );
    await this.commentResolutionService.resolveStaleFindings(
      pendingFindings,
      diffs,
      projectId,
      mrIid,
    );
  }
}

export type {
  PublishInlineParams,
  RepostCorrelatedParams,
  ResolveIncrementalParams,
};
export { ReviewFindingPublisherService };
