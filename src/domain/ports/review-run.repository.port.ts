import type {
  ReviewRun,
  ReviewStatus,
  TriggerType,
} from "~/domain/types/review.types";

interface CreateReviewRunInput {
  baseCommitSha: string;
  headCommitSha: string;
  isIncremental: boolean;
  mrIid: number;
  previousRunId?: string | undefined;
  projectId: number;
  startedAt: Date;
  triggerType: TriggerType;
}

interface FailReviewRunInput {
  errorMessage: string;
  timestamp: Date;
}

interface ReclaimStuckReviewRunInput {
  id: string;
  isIncremental: boolean;
  previousRunId?: string | undefined;
  startedAt: Date;
  stuckBefore: Date;
}

interface RestartFailedReviewRunInput {
  id: string;
  isIncremental: boolean;
  previousRunId?: string | undefined;
  startedAt: Date;
}

interface FindLatestReviewRunOptions {
  includeFailedForBaseline?: boolean | undefined;
}

interface UpdateReviewRunStatsInput {
  completionTokens?: number | undefined;
  configSnapshot?: Record<string, unknown> | undefined;
  criticalCount?: number | undefined;
  errorMessage?: string | undefined;
  filesReviewed?: number | undefined;
  promptTokens?: number | undefined;
  reviewModel?: string | undefined;
  totalCost?: number | undefined;
  totalFindings?: number | undefined;
  triageModel?: string | undefined;
  warningCount?: number | undefined;
}

interface IReviewRunRepository {
  completeRun(
    id: string,
    params: {
      baseCommitSha: string;
      stats: UpdateReviewRunStatsInput;
      timestamp: Date;
    },
  ): Promise<void>;
  create(input: CreateReviewRunInput): Promise<ReviewRun>;
  deleteCompletedOrFailedBefore(now: Date): Promise<number>;
  failRun(id: string, params: FailReviewRunInput): Promise<void>;
  findById(id: string): Promise<ReviewRun | undefined>;
  findByIdentity(
    projectId: number,
    mrIid: number,
    headCommitSha: string,
    baseCommitSha: string,
    triggerType: TriggerType,
  ): Promise<ReviewRun | undefined>;
  failStuckRun(id: string, params: FailReviewRunInput): Promise<boolean>;
  findByProjectAndMr(projectId: number, mrIid: number): Promise<ReviewRun[]>;
  findLatestByProjectAndMr(
    projectId: number,
    mrIid: number,
    triggerType?: TriggerType,
    options?: FindLatestReviewRunOptions,
  ): Promise<ReviewRun | undefined>;
  reclaimStuckRun(
    input: ReclaimStuckReviewRunInput,
  ): Promise<ReviewRun | undefined>;
  restartFailedRun(
    input: RestartFailedReviewRunInput,
  ): Promise<ReviewRun | undefined>;
  updateStats(id: string, stats: UpdateReviewRunStatsInput): Promise<void>;
  updateStatus(
    id: string,
    status: ReviewStatus,
    timestamp?: Date,
  ): Promise<void>;
}

export type {
  CreateReviewRunInput,
  FailReviewRunInput,
  FindLatestReviewRunOptions,
  IReviewRunRepository,
  ReclaimStuckReviewRunInput,
  RestartFailedReviewRunInput,
  UpdateReviewRunStatsInput,
};
