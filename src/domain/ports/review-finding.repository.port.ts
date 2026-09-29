import type { RuleId } from "~/domain/rule-catalog/rule-catalog.types";
import type {
  CommentResolution,
  Finding,
  FindingCategory,
  ReviewFinding,
} from "~/domain/types/review.types";

interface CreateReviewFindingInput extends Omit<
  Finding,
  "category" | "ruleId"
> {
  category: FindingCategory;
  hostDiscussionId?: string | undefined;
  hostNoteId?: string | undefined;
  reviewRunId: string;
  ruleId: RuleId;
}

interface IReviewFindingRepository {
  createMany(findings: CreateReviewFindingInput[]): Promise<ReviewFinding[]>;
  existsByHostDiscussionId(
    projectId: number,
    mrIid: number,
    hostDiscussionId: string,
  ): Promise<boolean>;
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
