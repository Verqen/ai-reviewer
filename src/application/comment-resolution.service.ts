import type { FastifyBaseLogger } from "fastify";

import { unresolveDiscussionsAfterFailedPersist } from "~/application/finding-addressed-sync.helper";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { ParsedFileDiff } from "~/review/diff-parser";

interface ResolutionResult {
  addressed: string[];
  pending: string[];
}

class CommentResolutionService {
  constructor(
    private readonly reviewFindingRepo: IReviewFindingRepository,
    private readonly codeHost: ICodeHost,
    private readonly logger: FastifyBaseLogger
  ) {}

  async resolveStaleFindings(
    previousFindings: ReviewFinding[],
    newDiffs: ParsedFileDiff[],
    projectId: number,
    mrIid: number
  ): Promise<ResolutionResult> {
    const addressed: string[] = [];
    const pending: string[] = [];
    const diffsByPath = new Map(newDiffs.map((d) => [d.newPath, d]));

    for (const finding of previousFindings) {
      const diff = diffsByPath.get(finding.filePath);

      if (!diff) {
        pending.push(finding.id);
        continue;
      }

      const fileDeleted =
        diff.lines.length === 0 && diff.newPath !== diff.oldPath;

      if (fileDeleted || this.lineWasModified(finding, diff)) {
        let isDiscussionResolved = false;
        if (finding.hostDiscussionId) {
          try {
            await this.codeHost.resolveDiscussion(
              projectId,
              mrIid,
              finding.hostDiscussionId
            );
            isDiscussionResolved = true;
          } catch (err) {
            this.logger.warn(
              { discussionId: finding.hostDiscussionId, err },
              "Failed to resolve GitLab discussion for addressed finding"
            );
            pending.push(finding.id);
            continue;
          }
        }
        try {
          await this.reviewFindingRepo.updateResolution(
            finding.id,
            "addressed"
          );
          addressed.push(finding.id);
        } catch (err) {
          if (isDiscussionResolved && finding.hostDiscussionId) {
            await unresolveDiscussionsAfterFailedPersist(
              {
                codeHost: this.codeHost,
                logger: this.logger,
                mrIid,
                projectId,
              },
              [
                {
                  discussionId: finding.hostDiscussionId,
                  findingId: finding.id,
                },
              ]
            );
          }
          this.logger.warn(
            { err, findingId: finding.id },
            "Failed to update finding resolution to addressed"
          );
          pending.push(finding.id);
        }
      } else {
        pending.push(finding.id);
      }
    }

    return { addressed, pending };
  }

  private lineWasModified(
    finding: ReviewFinding,
    diff: ParsedFileDiff
  ): boolean {
    const relevantLines = diff.lines.filter(
      (line) => line.type === "added" || line.type === "removed"
    );

    return relevantLines.some((line) => {
      if (finding.lineType === "removed") {
        return line.type === "removed" && line.oldLine === finding.lineNumber;
      }
      return (
        (line.type === "added" || line.type === "removed") &&
        line.newLine === finding.lineNumber
      );
    });
  }
}

export { CommentResolutionService };

export type { ResolutionResult };
