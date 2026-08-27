import { describe, expect, it, vi, type Mock } from "vitest";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding } from "~/domain/types/review.types";
import { createMockCommentResolutionService } from "~/test-utils/mock-comment-resolution-service";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewFindingRepository } from "~/test-utils/mock-review-finding-repository";

import { ReviewFindingPublisherService } from "./review-finding-publisher.service";

function makeFinding(comment: string): Finding {
  return {
    category: "bug",
    comment,
    confidence: 0.9,
    filePath: "src/app.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    severity: "warning",
  };
}

function makeDiffs(): ParsedFileDiff[] {
  return [
    {
      lines: [
        {
          content: "import { router } from './user/user.router';",
          hunkHeader: "@@ -1,1 +1,1 @@",
          newLine: 1,
          type: "added",
        },
      ],
      newPath: "src/app.ts",
      oldPath: "src/app.ts",
    },
  ];
}

function makeInfraRepoPorts(): ReviewInfraRepoPorts & {
  createManyMock: Mock<IReviewFindingRepository["createMany"]>;
  updateResolutionManyMock: Mock<
    IReviewFindingRepository["updateResolutionMany"]
  >;
} {
  const createManyMock = vi
    .fn<IReviewFindingRepository["createMany"]>()
    .mockResolvedValue([]);
  const updateResolutionManyMock = vi
    .fn<IReviewFindingRepository["updateResolutionMany"]>()
    .mockResolvedValue(undefined);

  return {
    ...createMockInfraRepoPorts({
      reviewFindingRepo: createMockReviewFindingRepository({
        createMany: createManyMock,
        updateResolutionMany: updateResolutionManyMock,
      }),
    }),
    createManyMock,
    updateResolutionManyMock,
  };
}

function makeCodeHost(params: {
  existingFilePathsAtHead?: string[];
}): ICodeHost & {
  getFileContentMock: ReturnType<typeof vi.fn>;
  postInlineCommentMock: ReturnType<typeof vi.fn>;
  replyToDiscussionMock: ReturnType<typeof vi.fn>;
  resolveDiscussionMock: ReturnType<typeof vi.fn>;
} {
  const existing = new Set(params.existingFilePathsAtHead ?? []);
  const getFileContentMock = vi.fn(
    (_projectId: number, _ref: string, path: string) => {
      if (existing.has(path)) {
        return Promise.resolve("// file exists");
      }
      return Promise.reject(new Error("File not found"));
    },
  );
  const postInlineCommentMock = vi.fn(() =>
    Promise.resolve({ discussionId: "discussion-id", noteId: "note-id" }),
  );
  const replyToDiscussionMock = vi.fn(() =>
    Promise.resolve({ noteId: "note-id" }),
  );
  const resolveDiscussionMock = vi.fn(() => Promise.resolve());
  return {
    approveMergeRequest: () => Promise.resolve(),
    getBranchHeadSha: () => Promise.resolve("head"),
    getCommitRangeDiff: () => Promise.resolve([]),
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: getFileContentMock,
    getFileContentMock,
    getFileTree: () => Promise.resolve([]),
    getMergeRequestDiff: () => Promise.resolve([]),
    getMergeRequestInfo: () =>
      Promise.resolve({
        description: "",
        iid: 1,
        projectId: 1,
        sourceBranch: "feature",
        targetBranch: "main",
        title: "title",
      }),
    getMergeRequestVersions: () =>
      Promise.resolve({
        baseSha: "base",
        headSha: "head",
        startSha: "start",
      }),
    getRepositoryArchive: () => Promise.resolve([]),
    listOpenMergeRequests: () => Promise.resolve([]),
    postInlineComment: postInlineCommentMock,
    postInlineCommentMock,
    postNote: () => Promise.resolve({ noteId: "note-id" }),
    replyToDiscussion: replyToDiscussionMock,
    replyToDiscussionMock,
    resolveDiscussion: resolveDiscussionMock,
    resolveDiscussionMock,
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: () => Promise.resolve(),
  };
}

describe("ReviewFindingPublisherService missing-file validator", () => {
  it("drops finding when referenced import path exists at MR head", async () => {
    const finding = makeFinding(
      "Imports a file that does not exist './user/user.router.ts'. File not found in the repository.",
    );
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({
      existingFilePathsAtHead: ["src/user/user.router.ts"],
    });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );

    await service.publishInlineFindingsAndStore({
      allFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(codeHost.postInlineCommentMock).not.toHaveBeenCalled();
    expect(infra.createManyMock).not.toHaveBeenCalled();
  });

  it("keeps finding when referenced import path does not exist at MR head", async () => {
    const finding = makeFinding(
      "Imports a file that does not exist './user/missing.router.ts'. File not found in the repository.",
    );
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );

    await service.publishInlineFindingsAndStore({
      allFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(codeHost.postInlineCommentMock).toHaveBeenCalledTimes(1);
    expect(infra.createManyMock).toHaveBeenCalledTimes(1);
  });

  it("drops finding when import path cannot be extracted or resolved safely", async () => {
    const finding = makeFinding(
      "Imports a file that does not exist '@alias/user.router'. File not found in the repository.",
    );
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );

    await service.publishInlineFindingsAndStore({
      allFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });

    expect(codeHost.postInlineCommentMock).not.toHaveBeenCalled();
    expect(infra.createManyMock).not.toHaveBeenCalled();
  });

  it("does not publish finding when line is outside current diff hunk", async () => {
    const finding = {
      ...makeFinding("Outside hunk line"),
      lineNumber: 999,
    };
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );
    await service.publishInlineFindingsAndStore({
      allFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).not.toHaveBeenCalled();
    expect(infra.createManyMock).toHaveBeenCalledTimes(1);
  });

  it("publishes valid finding without snapped-from marker", async () => {
    const finding = makeFinding("Valid in-hunk finding");
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );
    await service.publishInlineFindingsAndStore({
      allFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledTimes(1);
    const postedBody = codeHost.postInlineCommentMock.mock.calls[0]?.[2] as
      | string
      | undefined;
    expect(postedBody).not.toContain("Snapped from");
  });
});

describe("ReviewFindingPublisherService force-push correlation lifecycle", () => {
  it("marks original correlated finding as addressed after successful repost", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
    );
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...makeFinding("Correlated finding"),
            hostDiscussionId: "old-discussion-id",
            id: "finding-1",
            resolution: "pending",
            reviewRunId: "run-old",
          },
          newLineNumber: 10,
        },
      ],
      mrIid: 1,
      projectId: 1,
      reviewRunId: "run-new",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledTimes(1);
    expect(codeHost.replyToDiscussionMock).toHaveBeenCalledTimes(1);
    expect(codeHost.resolveDiscussionMock).toHaveBeenCalledTimes(1);
    expect(infra.updateResolutionManyMock).toHaveBeenCalledWith(
      ["finding-1"],
      "addressed",
    );
  });
});
