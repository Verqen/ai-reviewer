import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type {
  CreateDismissedPatternInput,
  DismissedPattern,
} from "~/domain/ports/dismissed-pattern.repository.port";
import type { CreateReviewFindingInput } from "~/domain/ports/review-finding.repository.port";
import type {
  CreateReviewRunInput,
  FindLatestReviewRunOptions,
  UpdateReviewRunStatsInput,
} from "~/domain/ports/review-run.repository.port";
import type {
  BaselineState,
  ContentMatch,
} from "~/domain/ports/snapshot.repository.port";
import type {
  CommentResolution,
  FindingCategory,
  ReviewFinding,
  ReviewRun,
  ReviewStatus,
  TriggerType,
} from "~/domain/types/review.types";

function createMockReviewRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    baseCommitSha: "base-sha",
    headCommitSha: "head-sha",
    id: "run-id-1",
    isIncremental: false,
    mrIid: 1,
    projectId: 1,
    queuedAt: new Date(),
    status: "queued",
    triggerType: "mr_open",
    ...overrides,
  };
}

interface MockInfraRepoPorts extends ReviewInfraRepoPorts {
  calls: {
    completeRun: Array<
      [
        string,
        {
          baseCommitSha: string;
          stats: UpdateReviewRunStatsInput;
          timestamp: Date;
        },
      ]
    >;
    createFinding: CreateReviewFindingInput[][];
    createRun: CreateReviewRunInput[];
    deleteCompletedOrFailedBefore: Date[];
    findByIdentity: Array<[number, number, string, string, TriggerType]>;
    updateStats: Array<[string, UpdateReviewRunStatsInput]>;
    updateStatus: Array<[string, ReviewStatus, Date | undefined]>;
  };
  setCompletedRun(run: ReviewRun | undefined): void;
  setCreatedRun(run: ReviewRun): void;
}

function createMockInfraRepoPorts(): MockInfraRepoPorts {
  let completedRun: ReviewRun | undefined = undefined;
  let createdRun: ReviewRun = createMockReviewRun();

  const calls: MockInfraRepoPorts["calls"] = {
    completeRun: [],
    createFinding: [],
    createRun: [],
    deleteCompletedOrFailedBefore: [],
    findByIdentity: [],
    updateStats: [],
    updateStatus: [],
  };

  const mock: MockInfraRepoPorts = {
    calls,

    dismissedPatternRepo: {
      create(_input: CreateDismissedPatternInput): Promise<DismissedPattern> {
        throw new Error("not implemented in mock");
      },

      findByProject(_projectId: number): Promise<DismissedPattern[]> {
        return Promise.resolve([]);
      },

      findSimilar(
        _projectId: number,
        _category: FindingCategory,
        _comment: string,
      ): Promise<DismissedPattern | undefined> {
        return Promise.resolve(undefined);
      },

      incrementOccurrence(_id: string): Promise<void> {
        return Promise.resolve();
      },
    },

    reviewFindingRepo: {
      createMany(
        findings: CreateReviewFindingInput[],
      ): Promise<ReviewFinding[]> {
        calls.createFinding.push(findings);
        return Promise.resolve([]);
      },

      findByProjectAndMr(
        _projectId: number,
        _mrIid: number,
      ): Promise<ReviewFinding[]> {
        return Promise.resolve([]);
      },

      findByRunId(_reviewRunId: string): Promise<ReviewFinding[]> {
        return Promise.resolve([]);
      },

      updateResolution(
        _id: string,
        _resolution: CommentResolution,
        _resolvedBy?: string,
        _dismissReason?: string,
      ): Promise<void> {
        return Promise.resolve();
      },
      updateResolutionMany(
        _ids: readonly string[],
        _resolution: CommentResolution,
        _resolvedBy?: string,
        _dismissReason?: string,
      ): Promise<void> {
        return Promise.resolve();
      },
    },

    reviewRunRepo: {
      completeRun(
        id: string,
        params: {
          baseCommitSha: string;
          stats: UpdateReviewRunStatsInput;
          timestamp: Date;
        },
      ): Promise<void> {
        calls.completeRun.push([id, params]);
        return Promise.resolve();
      },

      create(input: CreateReviewRunInput): Promise<ReviewRun> {
        calls.createRun.push(input);
        return Promise.resolve(createdRun);
      },

      deleteCompletedOrFailedBefore(now: Date): Promise<number> {
        calls.deleteCompletedOrFailedBefore.push(now);
        return Promise.resolve(0);
      },

      failStuckRun(
        _id: string,
        _params: { errorMessage: string; timestamp: Date },
      ): Promise<boolean> {
        return Promise.resolve(true);
      },

      findById(_id: string): Promise<ReviewRun | undefined> {
        return Promise.resolve(undefined);
      },

      findByIdentity(
        projectId: number,
        mrIid: number,
        headCommitSha: string,
        baseCommitSha: string,
        triggerType: TriggerType,
      ): Promise<ReviewRun | undefined> {
        calls.findByIdentity.push([
          projectId,
          mrIid,
          headCommitSha,
          baseCommitSha,
          triggerType,
        ]);
        return Promise.resolve(completedRun);
      },

      findByProjectAndMr(
        _projectId: number,
        _mrIid: number,
      ): Promise<ReviewRun[]> {
        return Promise.resolve([]);
      },

      findLatestByProjectAndMr(
        _projectId: number,
        _mrIid: number,
        _triggerType?: TriggerType,
        _options?: FindLatestReviewRunOptions,
      ): Promise<ReviewRun | undefined> {
        return Promise.resolve(undefined);
      },

      updateStats(id: string, stats: UpdateReviewRunStatsInput): Promise<void> {
        calls.updateStats.push([id, stats]);
        return Promise.resolve();
      },

      updateStatus(
        id: string,
        status: ReviewStatus,
        timestamp?: Date,
      ): Promise<void> {
        calls.updateStatus.push([id, status, timestamp]);
        return Promise.resolve();
      },
    },

    setCompletedRun(run: ReviewRun | undefined): void {
      completedRun = run;
    },

    setCreatedRun(run: ReviewRun): void {
      createdRun = run;
    },

    snapshotRepo: {
      copySnapshotEntries(
        _projectId: number,
        _fromSha: string,
        _toSha: string,
        _excludePaths?: Set<string>,
      ): Promise<number> {
        return Promise.resolve(0);
      },

      deleteCommit(_projectId: number, _commitSha: string): Promise<void> {
        return Promise.resolve();
      },

      deleteOldSnapshotsBefore(_now: Date): Promise<number> {
        return Promise.resolve(0);
      },

      getBaselineState(_projectId: number): Promise<BaselineState | null> {
        return Promise.resolve(null);
      },

      getFileContent(
        _projectId: number,
        _commitSha: string,
        _filePath: string,
      ): Promise<string | null> {
        return Promise.resolve(null);
      },

      listFiles(
        _projectId: number,
        _commitSha: string,
        _pattern?: string,
      ): Promise<string[]> {
        return Promise.resolve([]);
      },

      listPackageRootsFromSnapshot(): Promise<{
        hasTopLevelSrcTree: boolean;
        packageRoots: readonly string[];
        packageRootsUsingSrc: readonly string[];
      }> {
        return Promise.resolve({
          hasTopLevelSrcTree: false,
          packageRoots: [],
          packageRootsUsingSrc: [],
        });
      },

      searchContent(
        _projectId: number,
        _commitSha: string,
        _pattern: string,
        _glob?: string,
      ): Promise<ContentMatch[]> {
        return Promise.resolve([]);
      },

      setBaselineState(
        _projectId: number,
        _commitSha: string,
        _status: BaselineState["status"],
        _errorMessage?: string,
      ): Promise<void> {
        return Promise.resolve();
      },

      storeBlobs(
        _blobs: Array<{ content: Buffer; hash: string }>,
      ): Promise<void> {
        return Promise.resolve();
      },

      storeSnapshot(_params: {
        commitSha: string;
        entries: Array<{ blobHash: string; filePath: string }>;
        projectId: number;
      }): Promise<void> {
        return Promise.resolve();
      },
    },
  };

  return mock;
}

export { createMockInfraRepoPorts, createMockReviewRun };
export type { MockInfraRepoPorts };
