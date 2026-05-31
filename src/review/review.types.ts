import type {
  CommentContext,
  ReviewFinding,
  TriggerType,
} from "~/domain/types/review.types";

interface IReviewService {
  respondToComment(
    projectId: number,
    mrIid: number,
    context: CommentContext
  ): Promise<void>;
  respondToFindingThreadClarification(
    projectId: number,
    mrIid: number,
    finding: ReviewFinding,
    developerNote: string
  ): Promise<string>;
  reviewMergeRequest(
    projectId: number,
    mrIid: number,
    triggerType: TriggerType,
    previousRunId?: string
  ): Promise<void>;
}

export type { IReviewService };
