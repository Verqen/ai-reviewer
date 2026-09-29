import { describe, expect, it, vi, type Mock } from "vitest";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import { buildCatalogFinding } from "~/domain/rule-catalog/catalog-finding";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { CatalogRule } from "~/domain/rule-catalog/rule-catalog.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding } from "~/domain/types/review.types";
import { createMockCommentResolutionService } from "~/test-utils/mock-comment-resolution-service";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewFindingRepository } from "~/test-utils/mock-review-finding-repository";
import { formatFindingComment } from "~/review/finding-comment";

import { ReviewFindingPublisherService } from "./review-finding-publisher.service";

function requireRule(id: string): CatalogRule {
  const rule = findCatalogRule(id);
  if (rule === undefined) {
    throw new Error(`Missing catalog rule ${id}`);
  }
  return rule;
}

function makeFinding(): Finding {
  return buildCatalogFinding(requireRule("R-013"), {
    confidence: 0.9,
    filePath: "src/app.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
  });
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

describe("ReviewFindingPublisherService inline publication", () => {
  it("does not publish finding when line is outside current diff hunk", async () => {
    const finding = { ...makeFinding(), lineNumber: 999 };
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      undefined,
    );
    await service.publishInlineFindingsAndStore({
      acceptedFindings: [finding],
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

  it("publishes a valid finding as one inline comment", async () => {
    const finding = makeFinding();
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      undefined,
    );
    await service.publishInlineFindingsAndStore({
      acceptedFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledTimes(1);
  });

  it("posts the catalog comment format", async () => {
    const finding = makeFinding();
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      "https://rules.example.com/rules",
    );
    await service.publishInlineFindingsAndStore({
      acceptedFindings: [finding],
      diffs: makeDiffs(),
      mrIid: 1,
      postableFindings: [finding],
      projectId: 1,
      reviewRunId: "run-1",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining(
        "**R-013 · Identifier used but not declared or imported** · attention",
      ),
      expect.anything(),
    );
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("Rule: https://rules.example.com/rules#R-013"),
      expect.anything(),
    );
  });

  it("reposts a correlated finding in the catalog comment format", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      undefined,
    );
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...makeFinding(),
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
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining(
        "**R-013 · Identifier used but not declared or imported** · attention",
      ),
      expect.anything(),
    );
  });
});

describe("ReviewFindingPublisherService force-push correlation lifecycle", () => {
  it("reposts the catalog text and severity instead of the stored comment", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      undefined,
    );
    const rule = requireRule("R-013");
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...makeFinding(),
            category: "correctness",
            comment: "stored free text from an older run",
            hostDiscussionId: "old-discussion-id",
            id: "finding-1",
            resolution: "pending",
            reviewRunId: "run-old",
            severity: "nitpick",
          },
          newLineNumber: 10,
        },
      ],
      mrIid: 1,
      projectId: 1,
      reviewRunId: "run-new",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      formatFindingComment(
        { comment: rule.finding, ruleId: rule.id, severity: rule.severity },
        undefined,
      ),
      expect.anything(),
    );
    expect(infra.createManyMock).toHaveBeenCalledWith([
      expect.objectContaining({
        category: rule.category,
        comment: rule.finding,
        severity: rule.severity,
      }),
    ]);
  });

  it("drops a finding whose rule id is not in the catalog instead of reposting it", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const warn = vi.fn();
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger({ warn }),
      undefined,
    );
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...makeFinding(),
            hostDiscussionId: "old-discussion-id",
            id: "finding-unknown",
            resolution: "pending",
            reviewRunId: "run-old",
            ruleId: "R-999",
          },
          newLineNumber: 10,
        },
      ],
      mrIid: 1,
      projectId: 1,
      reviewRunId: "run-new",
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    });
    expect(codeHost.postInlineCommentMock).not.toHaveBeenCalled();
    expect(infra.createManyMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { filePath: "src/app.ts", findingId: "finding-unknown" },
      "Dropping legacy finding without a catalog rule id from force-push repost",
    );
  });

  it("marks original correlated finding as addressed after successful repost", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger(),
      undefined,
    );
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...makeFinding(),
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

  it("drops a legacy finding without a catalog rule id instead of reposting it", async () => {
    const infra = makeInfraRepoPorts();
    const codeHost = makeCodeHost({ existingFilePathsAtHead: [] });
    const warn = vi.fn();
    const service = new ReviewFindingPublisherService(
      infra,
      codeHost,
      createMockCommentResolutionService(),
      createMockLogger({ warn }),
      undefined,
    );
    const { ruleId: _ruleId, ...legacyFinding } = makeFinding();
    await service.repostCorrelatedFindings({
      correlated: [
        {
          finding: {
            ...legacyFinding,
            hostDiscussionId: "old-discussion-id",
            id: "finding-legacy",
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
    expect(codeHost.postInlineCommentMock).not.toHaveBeenCalled();
    expect(infra.createManyMock).not.toHaveBeenCalled();
    expect(infra.updateResolutionManyMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { filePath: "src/app.ts", findingId: "finding-legacy" },
      "Dropping legacy finding without a catalog rule id from force-push repost",
    );
  });
});
