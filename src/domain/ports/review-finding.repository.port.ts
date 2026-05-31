import type {
  CommentResolution,
  Finding,
  ReviewFinding,
} from "~/domain/types/review.types";

interface CreateReviewFindingInput extends Finding {
  hostDiscussionId?: string | undefined;
  hostNoteId?: string | undefined;
  reviewRunId: string;
}

interface IReviewFindingRepository {
  createMany(findings: CreateReviewFindingInput[]): Promise<ReviewFinding[]>;
  findByProjectAndMr(
    projectId: number,
    mrIid: number,
  ): Promise<ReviewFinding[]>;
  findByRunId(reviewRunId: string): Promise<ReviewFinding[]>;
  updateResolution(
    id: string,
    resolution: CommentResolution,
    resolvedBy?: string,
    dismissReason?: string,
  ): Promise<void>;
  updateResolutionMany(
    ids: readonly string[],
    resolution: CommentResolution,
    resolvedBy?: string,
    dismissReason?: string,
  ): Promise<void>;
}

export type { CreateReviewFindingInput, IReviewFindingRepository };
