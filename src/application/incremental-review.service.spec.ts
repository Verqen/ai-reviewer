import { Registry } from "prom-client";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ForcePushCorrelationService } from "~/application/force-push-correlation.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import { PipelineConfig } from "~/config/pipeline.config";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { DiffFile } from "~/domain/types/code-host.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";
import type { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
import {
  createMockInfraRepoPorts,
  createMockReviewRun,
} from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockPipelineMetrics } from "~/test-utils/mock-pipeline-metrics";
import { createMockPipelineOrchestrator } from "~/test-utils/mock-pipeline-orchestrator";
import { createMockReviewFindingRepository } from "~/test-utils/mock-review-finding-repository";
import { createMockReviewRunRepository } from "~/test-utils/mock-review-run-repository";

import { IncrementalReviewService } from "./incremental-review.service";

const ADDED_LINE_DIFF =
  "@@ -1,3 +1,4 @@\n context\n+new line added here\n existing\n last\n";

function makePipelineConfig(): PipelineConfig {
  return new PipelineConfig();
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: "bug",
    comment: "test finding",
    confidence: 0.9,
    filePath: "src/foo.ts",
    hostDiscussionId: "disc-abc",
    id: "finding-1",
    lineExcerpt: "existing",
    lineNumber: 3,
    lineType: "added",
    model: "test",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-old",
    severity: "warning",
    ...overrides,
  };
}

function makeCodeHost(
  options: {
    commitRangeDiffs?: DiffFile[];
    mrDiffs?: DiffFile[];
    throwOnCommitRange?: Error;
    throwOnReplyToDiscussion?: Error;
    throwOnResolveDiscussion?: Error;
    throwOnUnresolveDiscussion?: Error;
  } = {},
): ICodeHost & {
  getCommitRangeDiffMock: ReturnType<typeof vi.fn>;
  getMergeRequestDiffMock: ReturnType<typeof vi.fn>;
  postInlineCommentCalls: string[];
  postNoteCalls: string[];
  replyToDiscussionCalls: string[];
  replyToDiscussionMock: ReturnType<typeof vi.fn>;
  resolveDiscussionCalls: string[];
  resolveDiscussionMock: ReturnType<typeof vi.fn>;
  unresolveDiscussionCalls: string[];
  unresolveDiscussionMock: ReturnType<typeof vi.fn>;
} {
  const postInlineCommentCalls: string[] = [];
  const postNoteCalls: string[] = [];
  const replyToDiscussionCalls: string[] = [];
  const resolveDiscussionCalls: string[] = [];
  const unresolveDiscussionCalls: string[] = [];
  const replyToDiscussionMock = vi.fn(
    (_pid: number, _mrIid: number, discussionId: string) => {
      if (options.throwOnReplyToDiscussion) {
        return Promise.reject(options.throwOnReplyToDiscussion);
      }
      replyToDiscussionCalls.push(discussionId);
      return Promise.resolve({ noteId: "n" });
    },
  );
  const resolveDiscussionMock = vi.fn(
    (_pid: number, _mrIid: number, discussionId: string) => {
      if (options.throwOnResolveDiscussion) {
        return Promise.reject(options.throwOnResolveDiscussion);
      }
      resolveDiscussionCalls.push(discussionId);
      return Promise.resolve();
    },
  );
  const unresolveDiscussionMock = vi.fn(
    (_pid: number, _mrIid: number, discussionId: string) => {
      if (options.throwOnUnresolveDiscussion) {
        return Promise.reject(options.throwOnUnresolveDiscussion);
      }
      unresolveDiscussionCalls.push(discussionId);
      return Promise.resolve();
    },
  );

  const getCommitRangeDiffMock = vi.fn(
    (
      _projectId: number,
      _from: string,
      _to: string,
      _opts?: { straight?: boolean | undefined },
    ) => {
      if (options.throwOnCommitRange) {
        return Promise.reject(options.throwOnCommitRange);
      }
      return Promise.resolve(options.commitRangeDiffs ?? []);
    },
  );

  const getMergeRequestDiffMock = vi.fn(() =>
    Promise.resolve(options.mrDiffs ?? options.commitRangeDiffs ?? []),
  );

  return {
    approveMergeRequest: () => Promise.resolve(),
    getBranchHeadSha: () => Promise.resolve("abc123"),
    getCommitRangeDiff: getCommitRangeDiffMock,
    getCommitRangeDiffMock,
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(""),
    getFileTree: () => Promise.resolve([]),
    getMergeRequestDiff: getMergeRequestDiffMock,
    getMergeRequestDiffMock,
    getMergeRequestInfo: () =>
      Promise.resolve({
        description: "",
        iid: 1,
        projectId: 1,
        sourceBranch: "f",
        targetBranch: "main",
        title: "t",
      }),
    getMergeRequestVersions: vi.fn(() =>
      Promise.resolve({ baseSha: "base", headSha: "head", startSha: "start" }),
    ),
    getRepositoryArchive: () => Promise.resolve([]),
    listOpenMergeRequests: () => Promise.resolve([]),
    postInlineComment: vi.fn((_pid: number, _mrIid: number, body: string) => {
      postInlineCommentCalls.push(body);
      return Promise.resolve({ discussionId: "d", noteId: "n" });
    }),
    postInlineCommentCalls,
    postNote: vi.fn((_pid: number, _mrIid: number, body: string) => {
      postNoteCalls.push(body);
      return Promise.resolve({ noteId: "n" });
    }),
    postNoteCalls,
    replyToDiscussion: replyToDiscussionMock,
    replyToDiscussionCalls,
    replyToDiscussionMock,
    resolveDiscussion: resolveDiscussionMock,
    resolveDiscussionCalls,
    resolveDiscussionMock,
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: unresolveDiscussionMock,
    unresolveDiscussionCalls,
    unresolveDiscussionMock,
  };
}

function makeInfraRepoPorts(
  options: {
    findingsByRunId?: ReviewFinding[];
    latestRun?: { headCommitSha: string; id: string } | undefined;
    throwOnUpdateResolution?: Error;
  } = {},
): ReviewInfraRepoPorts & {
  updateResolutionManyCalls: string[][];
  updateResolutionManyMock: Mock<
    IReviewFindingRepository["updateResolutionMany"]
  >;
  updateResolutionCalls: string[];
  updateResolutionMock: Mock<IReviewFindingRepository["updateResolution"]>;
} {
  const updateResolutionCalls: string[] = [];
  const updateResolutionManyCalls: string[][] = [];
  const updateResolutionMock = vi.fn<
    IReviewFindingRepository["updateResolution"]
  >((id) => {
    if (options.throwOnUpdateResolution) {
      return Promise.reject(options.throwOnUpdateResolution);
    }
    updateResolutionCalls.push(id);
    return Promise.resolve();
  });
  const updateResolutionManyMock = vi.fn<
    IReviewFindingRepository["updateResolutionMany"]
  >((ids) => {
    if (options.throwOnUpdateResolution) {
      return Promise.reject(options.throwOnUpdateResolution);
    }
    updateResolutionManyCalls.push([...ids]);
    return Promise.resolve();
  });

  return {
    ...createMockInfraRepoPorts({
      reviewFindingRepo: createMockReviewFindingRepository({
        findByRunId: () => Promise.resolve(options.findingsByRunId ?? []),
        updateResolution: updateResolutionMock,
        updateResolutionMany: updateResolutionManyMock,
      }),
      reviewRunRepo: createMockReviewRunRepository({
        create: () =>
          Promise.resolve(
            createMockReviewRun({
              baseCommitSha: "b",
              headCommitSha: "h",
              id: "run-1",
              isIncremental: true,
              triggerType: "push",
            }),
          ),
        findLatestByProjectAndMr: () =>
          Promise.resolve(
            options.latestRun
              ? createMockReviewRun({
                  baseCommitSha: "base",
                  headCommitSha: options.latestRun.headCommitSha,
                  id: options.latestRun.id,
                  status: "completed",
                })
              : undefined,
          ),
      }),
    }),
    updateResolutionCalls,
    updateResolutionManyCalls,
    updateResolutionManyMock,
    updateResolutionMock,
  };
}

function makeOrchestrator(): PipelineOrchestrator & { runCalls: unknown[] } {
  const runCalls: unknown[] = [];

  return Object.assign(
    createMockPipelineOrchestrator({
      run: (input) => {
        runCalls.push(input);
        return Promise.resolve();
      },
    }),
    { runCalls },
  );
}

function buildIncrementalReviewService(
  infraRepoPorts: ReviewInfraRepoPorts,
  codeHost: ICodeHost,
  orchestrator: PipelineOrchestrator,
  logger = createMockLogger(),
  metrics: PipelineMetrics = createMockPipelineMetrics(),
): IncrementalReviewService {
  return new IncrementalReviewService(
    infraRepoPorts,
    codeHost,
    orchestrator,
    logger,
    new ForcePushCorrelationService(
      infraRepoPorts,
      codeHost,
      makePipelineConfig(),
      logger,
    ),
    metrics,
  );
}

describe("IncrementalReviewService", () => {
  describe("normal push", () => {
    it("fetches delta diff and runs orchestrator with isIncremental=true", async () => {
      const deltaFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const codeHost = makeCodeHost({ commitRangeDiffs: [deltaFile] });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });

      expect(orchestrator.runCalls).toHaveLength(1);
      const call = orchestrator.runCalls[0] as Record<string, unknown>;
      expect(call["isIncremental"]).toBe(true);
      expect(call["triggerType"]).toBe("push");
      expect(codeHost.getCommitRangeDiffMock).toHaveBeenCalledWith(
        1,
        "old-sha",
        "new-sha",
        { straight: true },
      );
    });

    it("filters out rebase noise by scoping delta to current MR diff", async () => {
      const featureFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/feature.ts",
        oldPath: "src/feature.ts",
      };
      const contextOnlyFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/user/user.router.ts",
        oldPath: "src/user/user.router.ts",
      };
      const mainNoiseFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/noise-from-main.ts",
        oldPath: "src/noise-from-main.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [featureFile, mainNoiseFile],
        mrDiffs: [featureFile, contextOnlyFile],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });
      const call = orchestrator.runCalls[0] as {
        contextChangedPaths?: string[];
        diffs: Array<{ newPath: string }>;
      };
      expect(call.diffs.map((d) => d.newPath)).toEqual(["src/feature.ts"]);
      expect(call.contextChangedPaths).toEqual([
        "src/feature.ts",
        "src/user/user.router.ts",
      ]);
    });

    it("posts no-new-changes note when all delta files are outside current MR diff", async () => {
      const outsideMrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/outside-mr.ts",
        oldPath: "src/outside-mr.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [outsideMrFile],
        mrDiffs: [
          {
            diff: ADDED_LINE_DIFF,
            newPath: "src/in-mr.ts",
            oldPath: "src/in-mr.ts",
          },
        ],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });
      expect(orchestrator.runCalls).toHaveLength(0);
      expect(codeHost.postNoteCalls).toHaveLength(1);
      expect(codeHost.postNoteCalls[0]).toContain("No new reviewable changes");
    });

    it("keeps renamed files when oldPath exists in current MR diff", async () => {
      const renamedDeltaFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/new-name.ts",
        oldPath: "src/legacy-name.ts",
      };
      const mrRenameFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/another-new-name.ts",
        oldPath: "src/legacy-name.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [renamedDeltaFile],
        mrDiffs: [mrRenameFile],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });
      const call = orchestrator.runCalls[0] as {
        diffs: Array<{ newPath: string; oldPath: string }>;
      };
      expect(call.diffs.map((d) => [d.newPath, d.oldPath])).toEqual([
        ["src/new-name.ts", "src/legacy-name.ts"],
      ]);
    });

    it("keeps only overlapping hunks for the same file after rebase noise", async () => {
      const mixedDelta: DiffFile = {
        diff: "@@ -10,2 +10,2 @@\n-old main line\n+new main line\n shared\n@@ -100,2 +100,2 @@\n-old feature line\n+new feature line\n shared\n",
        newPath: "src/shared-file.ts",
        oldPath: "src/shared-file.ts",
      };
      const mrDiff: DiffFile = {
        diff: "@@ -100,2 +100,2 @@\n-old feature line\n+new feature line adjusted\n shared\n",
        newPath: "src/shared-file.ts",
        oldPath: "src/shared-file.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [mixedDelta],
        mrDiffs: [mrDiff],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });
      const call = orchestrator.runCalls[0] as {
        diffs: Array<{
          lines: Array<{ newLine?: number; oldLine?: number }>;
          newPath: string;
        }>;
      };
      expect(call.diffs).toHaveLength(1);
      expect(call.diffs[0]?.newPath).toBe("src/shared-file.ts");
      const scopedLines = call.diffs[0]?.lines ?? [];
      const referencedLines = scopedLines.flatMap((line) =>
        [line.newLine, line.oldLine].filter(
          (value): value is number => value !== undefined,
        ),
      );
      expect(referencedLines.every((line) => line >= 100)).toBe(true);
    });

    it("posts 'no new changes' note and skips orchestrator when delta is empty", async () => {
      const codeHost = makeCodeHost({ commitRangeDiffs: [] });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });

      expect(orchestrator.runCalls).toHaveLength(0);
      expect(codeHost.postNoteCalls.length).toBeGreaterThan(0);
      expect(codeHost.postNoteCalls[0]).toContain("No new reviewable changes");
    });

    it("passes previousRunId to orchestrator when previous run exists", async () => {
      const deltaFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const codeHost = makeCodeHost({ commitRangeDiffs: [deltaFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });

      const call = orchestrator.runCalls[0] as Record<string, unknown>;
      expect(call["previousRunId"]).toBe("run-prev");
    });
  });

  describe("force-push", () => {
    it("reviews only current MR diff for force-push", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [
          {
            diff: ADDED_LINE_DIFF,
            newPath: "src/noise-from-main.ts",
            oldPath: "src/noise-from-main.ts",
          },
        ],
        mrDiffs: [mrFile],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(orchestrator.runCalls).toHaveLength(1);
      const call = orchestrator.runCalls[0] as Record<string, unknown>;
      expect(call["triggerType"]).toBe("force_push");
      expect(call["isIncremental"]).toBe(true);
      expect(codeHost.getCommitRangeDiffMock).not.toHaveBeenCalled();
      expect(codeHost.getMergeRequestDiffMock).toHaveBeenCalledWith(1, 42);
      const diffs = call["diffs"] as Array<{ newPath: string }>;
      expect(diffs.map((d) => d.newPath)).toEqual(["src/foo.ts"]);
      const contextChangedPaths = call["contextChangedPaths"] as
        | string[]
        | undefined;
      expect(contextChangedPaths).toEqual(["src/foo.ts"]);
    });

    it("ignores delta noise and still reviews current MR diff on force-push", async () => {
      const outsideMrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/outside-mr.ts",
        oldPath: "src/outside-mr.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [outsideMrFile],
        mrDiffs: [
          {
            diff: ADDED_LINE_DIFF,
            newPath: "src/in-mr.ts",
            oldPath: "src/in-mr.ts",
          },
        ],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      expect(orchestrator.runCalls).toHaveLength(1);
      expect(codeHost.postNoteCalls).toHaveLength(0);
      const call = orchestrator.runCalls[0] as {
        diffs: Array<{ newPath: string }>;
      };
      expect(call.diffs.map((d) => d.newPath)).toEqual(["src/in-mr.ts"]);
    });
    it("passes both new file and new hunk file to orchestrator on force-push", async () => {
      const existingWithNewHunk: DiffFile = {
        diff: "@@ -40,1 +40,2 @@\n old\n+new hunk change\n",
        newPath: "src/existing.ts",
        oldPath: "src/existing.ts",
      };
      const newFile: DiffFile = {
        diff: "@@ -0,0 +1,2 @@\n+export const created = true;\n+export const value = 1;\n",
        newPath: "src/new-file.ts",
        oldPath: "src/new-file.ts",
      };
      const codeHost = makeCodeHost({
        mrDiffs: [existingWithNewHunk, newFile],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      const call = orchestrator.runCalls[0] as {
        contextChangedPaths?: string[] | undefined;
        diffs: Array<{ newPath: string }>;
      };
      expect(call.diffs.map((d) => d.newPath).sort()).toEqual(
        ["src/existing.ts", "src/new-file.ts"].sort(),
      );
      expect((call.contextChangedPaths ?? []).sort()).toEqual(
        ["src/existing.ts", "src/new-file.ts"].sort(),
      );
    });

    it("keeps force-push renamed files when oldPath exists in current MR diff", async () => {
      const renamedDeltaFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/new-name.ts",
        oldPath: "src/legacy-name.ts",
      };
      const mrRenameFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/another-new-name.ts",
        oldPath: "src/legacy-name.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [renamedDeltaFile],
        mrDiffs: [mrRenameFile],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      const call = orchestrator.runCalls[0] as {
        diffs: Array<{ newPath: string; oldPath: string }>;
      };
      expect(call.diffs.map((d) => [d.newPath, d.oldPath])).toEqual([
        ["src/another-new-name.ts", "src/legacy-name.ts"],
      ]);
    });

    it("keeps only overlapping hunks for force-push rebase on same file", async () => {
      const mixedDelta: DiffFile = {
        diff: "@@ -20,2 +20,2 @@\n-old main line\n+new main line\n shared\n@@ -120,2 +120,2 @@\n-old feature line\n+new feature line\n shared\n",
        newPath: "src/shared-file.ts",
        oldPath: "src/shared-file.ts",
      };
      const mrDiff: DiffFile = {
        diff: "@@ -120,2 +120,2 @@\n-old feature line\n+new feature line adjusted\n shared\n",
        newPath: "src/shared-file.ts",
        oldPath: "src/shared-file.ts",
      };
      const codeHost = makeCodeHost({
        commitRangeDiffs: [mixedDelta],
        mrDiffs: [mrDiff],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      const call = orchestrator.runCalls[0] as {
        diffs: Array<{
          lines: Array<{ newLine?: number; oldLine?: number }>;
          newPath: string;
        }>;
      };
      expect(call.diffs).toHaveLength(1);
      expect(call.diffs[0]?.newPath).toBe("src/shared-file.ts");
      const scopedLines = call.diffs[0]?.lines ?? [];
      const referencedLines = scopedLines.flatMap((line) =>
        [line.newLine, line.oldLine].filter(
          (value): value is number => value !== undefined,
        ),
      );
      expect(referencedLines.every((line) => line >= 120)).toBe(true);
    });

    it("does not depend on commit-range compare for force-push", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const codeHost = makeCodeHost({
        commitRangeDiffs: [],
        mrDiffs: [mrFile],
        throwOnCommitRange: new CodeHostNotFoundError("missing ref"),
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(codeHost.getCommitRangeDiffMock).not.toHaveBeenCalled();
      expect(codeHost.getMergeRequestDiffMock).toHaveBeenCalledWith(1, 42);
      expect(orchestrator.runCalls).toHaveLength(1);
    });

    it("returns correlated findings to orchestrator instead of reposting immediately", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-xyz",
        lineExcerpt: "existing",
        lineNumber: 3,
      });

      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(codeHost.postInlineCommentCalls).toHaveLength(0);
      expect(codeHost.replyToDiscussionCalls).toHaveLength(0);
      expect(codeHost.resolveDiscussionCalls).toHaveLength(0);
      const call = orchestrator.runCalls[0] as {
        forcePushCorrelation?: { correlated: unknown[] };
      };
      expect(call.forcePushCorrelation?.correlated).toHaveLength(1);
    });

    it("marks finding addressed when file not in new diff", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/bar.ts",
        oldPath: "src/bar.ts",
      };

      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-gone",
        lineExcerpt: "some code",
        lineNumber: 1,
      });

      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(infraRepoPorts.updateResolutionManyCalls).toEqual([["finding-1"]]);
      expect(codeHost.replyToDiscussionCalls).toContain("disc-gone");
      expect(codeHost.resolveDiscussionCalls).toContain("disc-gone");
      const firstReplyCallOrder =
        codeHost.replyToDiscussionMock.mock.invocationCallOrder[0];
      const firstResolveCallOrder =
        codeHost.resolveDiscussionMock.mock.invocationCallOrder[0];
      const firstUpdateCallOrder =
        infraRepoPorts.updateResolutionManyMock.mock.invocationCallOrder[0];
      if (
        firstReplyCallOrder === undefined ||
        firstResolveCallOrder === undefined ||
        firstUpdateCallOrder === undefined
      ) {
        throw new Error("Expected invocation call order values to be defined");
      }
      expect(firstReplyCallOrder).toBeLessThan(firstResolveCallOrder);
      expect(firstResolveCallOrder).toBeLessThan(firstUpdateCallOrder);
    });

    it("marks multiple findings with a single batch DB update", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/bar.ts",
        oldPath: "src/bar.ts",
      };
      const findings = [
        makeFinding({
          filePath: "src/foo.ts",
          hostDiscussionId: "disc-gone-1",
          id: "finding-1",
          lineExcerpt: "some code",
          lineNumber: 1,
        }),
        makeFinding({
          filePath: "src/baz.ts",
          hostDiscussionId: "disc-gone-2",
          id: "finding-2",
          lineExcerpt: "some code",
          lineNumber: 1,
        }),
      ];
      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: findings,
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      expect(infraRepoPorts.updateResolutionManyCalls).toEqual([
        ["finding-1", "finding-2"],
      ]);
    });

    it("marks finding addressed when line excerpt not found in new diff", async () => {
      const mrFile: DiffFile = {
        diff: "@@ -1,3 +1,3 @@\n context\n+completely different content\n old line\n",
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-lost",
        lineExcerpt: "nonexistent unique content xyz123",
        lineNumber: 2,
      });

      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(infraRepoPorts.updateResolutionManyCalls).toEqual([["finding-1"]]);
    });

    it("keeps finding pending when reply to discussion fails", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/bar.ts",
        oldPath: "src/bar.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-failed-reply",
        lineExcerpt: "some code",
        lineNumber: 1,
      });
      const codeHost = makeCodeHost({
        commitRangeDiffs: [mrFile],
        mrDiffs: [mrFile],
        throwOnReplyToDiscussion: new Error("reply failed"),
      });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      expect(infraRepoPorts.updateResolutionManyCalls).toHaveLength(0);
      const call = orchestrator.runCalls[0] as {
        forcePushCorrelation?: {
          addressed: string[];
          pending: string[];
        };
      };
      expect(call.forcePushCorrelation?.addressed).not.toContain("finding-1");
      expect(call.forcePushCorrelation?.pending).toContain("finding-1");
    });

    it("rolls back discussion resolution when DB update fails after resolve", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/bar.ts",
        oldPath: "src/bar.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-db-failed",
        lineExcerpt: "some code",
        lineNumber: 1,
      });
      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
        throwOnUpdateResolution: new Error("db failed"),
      });
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      expect(codeHost.resolveDiscussionCalls).toContain("disc-db-failed");
      expect(codeHost.unresolveDiscussionCalls).toContain("disc-db-failed");
      const call = orchestrator.runCalls[0] as {
        forcePushCorrelation?: {
          addressed: string[];
          pending: string[];
        };
      };
      expect(call.forcePushCorrelation?.addressed).not.toContain("finding-1");
      expect(call.forcePushCorrelation?.pending).toContain("finding-1");
    });

    it("keeps finding pending when rollback unresolve fails", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/bar.ts",
        oldPath: "src/bar.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-rollback-failed",
        lineExcerpt: "some code",
        lineNumber: 1,
      });
      const codeHost = makeCodeHost({
        commitRangeDiffs: [mrFile],
        throwOnUnresolveDiscussion: new Error("rollback failed"),
      });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
        throwOnUpdateResolution: new Error("db failed"),
      });
      const orchestrator = makeOrchestrator();
      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );
      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });
      const call = orchestrator.runCalls[0] as {
        forcePushCorrelation?: {
          addressed: string[];
          pending: string[];
        };
      };
      expect(call.forcePushCorrelation?.addressed).not.toContain("finding-1");
      expect(call.forcePushCorrelation?.pending).toContain("finding-1");
    });

    it("skips correlation for finding without hostDiscussionId", async () => {
      const mrFile: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };

      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: undefined,
        lineExcerpt: "existing",
        lineNumber: 3,
      });

      const codeHost = makeCodeHost({ commitRangeDiffs: [mrFile] });
      const infraRepoPorts = makeInfraRepoPorts({
        findingsByRunId: [finding],
        latestRun: { headCommitSha: "old-sha", id: "run-prev" },
      });
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "force_push",
      });

      expect(codeHost.replyToDiscussionCalls).toHaveLength(0);
      expect(codeHost.resolveDiscussionCalls).toHaveLength(0);
    });
  });

  describe("main-push scoped review", () => {
    it("runs orchestrator with MR diff filtered to changedFiles and triggerType main_push", async () => {
      const inScope: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/auth.service.ts",
        oldPath: "src/auth.service.ts",
      };
      const outOfScope: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/other.ts",
        oldPath: "src/other.ts",
      };
      const codeHost = makeCodeHost({ mrDiffs: [inScope, outOfScope] });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.runMainPushScopedReview({
        changedFiles: ["src/auth.service.ts"],
        mrIid: 42,
        previousRunId: "run-prev",
        projectId: 1,
      });

      expect(codeHost.getMergeRequestDiffMock).toHaveBeenCalledWith(1, 42);
      expect(orchestrator.runCalls).toHaveLength(1);
      const call = orchestrator.runCalls[0] as Record<string, unknown>;
      expect(call["isIncremental"]).toBe(true);
      expect(call["triggerType"]).toBe("main_push");
      expect(call["previousRunId"]).toBe("run-prev");
      const diffs = call["diffs"] as { newPath: string }[];
      expect(diffs.map((d) => d.newPath)).toEqual(["src/auth.service.ts"]);
    });

    it("skips orchestrator without posting note when scoped diff is empty after skip-filter", async () => {
      const lockDiff: DiffFile = {
        diff: "@@ -1,1 +1,1 @@\n-a\n+b\n",
        newPath: "pnpm-lock.yaml",
        oldPath: "pnpm-lock.yaml",
      };
      const codeHost = makeCodeHost({ mrDiffs: [lockDiff] });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
      );

      await service.runMainPushScopedReview({
        changedFiles: ["pnpm-lock.yaml"],
        mrIid: 42,
        previousRunId: "run-prev",
        projectId: 1,
      });

      expect(orchestrator.runCalls).toHaveLength(0);
      expect(codeHost.postNoteCalls.length).toBe(0);
    });
  });

  describe("skip-filter metrics", () => {
    it("increments ai_reviewer_files_skipped_total with reason label for each skipped file", async () => {
      const reviewable: DiffFile = {
        diff: ADDED_LINE_DIFF,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const lockDiff: DiffFile = {
        diff: "@@ -1,1 +1,1 @@\n-a\n+b\n",
        newPath: "pnpm-lock.yaml",
        oldPath: "pnpm-lock.yaml",
      };
      const localeDiff: DiffFile = {
        diff: "@@ -1,1 +1,1 @@\n-x\n+y\n",
        newPath: "src/locales/ru.po",
        oldPath: "src/locales/ru.po",
      };

      const codeHost = makeCodeHost({
        commitRangeDiffs: [reviewable, lockDiff, localeDiff],
      });
      const infraRepoPorts = makeInfraRepoPorts();
      const orchestrator = makeOrchestrator();
      const registry = new Registry();
      const metrics = new PipelineMetrics(registry);

      const service = buildIncrementalReviewService(
        infraRepoPorts,
        codeHost,
        orchestrator,
        createMockLogger(),
        metrics,
      );

      await service.run({
        mrIid: 42,
        newHeadSha: "new-sha",
        previousSha: "old-sha",
        projectId: 1,
        triggerType: "push",
      });

      const output = await registry.metrics();
      expect(output).toMatch(
        /ai_reviewer_files_skipped_total\{reason="lock"\} 1/,
      );
      expect(output).toMatch(
        /ai_reviewer_files_skipped_total\{reason="translation"\} 1/,
      );
      const call = orchestrator.runCalls[0] as {
        diffs: { newPath: string }[];
      };
      expect(call.diffs.map((d) => d.newPath)).toEqual(["src/foo.ts"]);
    });
  });
});
