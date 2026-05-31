import { describe, expect, it, vi } from "vitest";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { ParsedFileDiff } from "~/review/diff-parser";
import { createMockLogger } from "~/test-utils/mock-logger";

import { CommentResolutionService } from "./comment-resolution.service";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: "bug",
    comment: "test finding",
    confidence: 0.9,
    filePath: "src/foo.ts",
    id: "finding-1",
    lineNumber: 10,
    lineType: "added",
    model: "test",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
    ...overrides,
  };
}

function makeParsedDiff(
  overrides: Partial<ParsedFileDiff> = {},
): ParsedFileDiff {
  return {
    lines: [
      {
        content: "some code",
        hunkHeader: "@@ -10,3 +10,3 @@",
        newLine: 10,
        oldLine: 10,
        type: "context",
      },
    ],
    newPath: "src/foo.ts",
    oldPath: "src/foo.ts",
    ...overrides,
  };
}

function makeMockRepo(): IReviewFindingRepository & {
  resolutionCalls: Array<[string, string]>;
} {
  const resolutionCalls: Array<[string, string]> = [];

  return {
    createMany: () => Promise.resolve([]),
    findByProjectAndMr: () => Promise.resolve([]),
    findByRunId: () => Promise.resolve([]),
    resolutionCalls,
    updateResolution: vi.fn((id: string, resolution: string) => {
      resolutionCalls.push([id, resolution]);
      return Promise.resolve();
    }),
    updateResolutionMany: vi.fn(() => Promise.resolve()),
  };
}

function makeMockCodeHost(): ICodeHost & {
  resolveDiscussionCalls: string[];
  unresolveDiscussionCalls: string[];
} {
  const resolveDiscussionCalls: string[] = [];
  const unresolveDiscussionCalls: string[] = [];

  return {
    approveMergeRequest: () => Promise.resolve(),
    getCommitRangeDiff: () => Promise.resolve([]),
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(""),
    getFileTree: () => Promise.resolve([]),
    getMergeRequestDiff: () => Promise.resolve([]),
    getMergeRequestInfo: () =>
      Promise.resolve({
        description: "",
        iid: 1,
        projectId: 1,
        sourceBranch: "f",
        targetBranch: "main",
        title: "t",
      }),
    getMergeRequestVersions: () =>
      Promise.resolve({ baseSha: "b", headSha: "h", startSha: "s" }),
    listOpenMergeRequests: () => Promise.resolve([]),
    postInlineComment: () =>
      Promise.resolve({ discussionId: "d", noteId: "n" }),
    postNote: () => Promise.resolve({ noteId: "n" }),
    replyToDiscussion: () => Promise.resolve({ noteId: "n" }),
    resolveDiscussion: vi.fn(
      (_projectId: number, _mrIid: number, discussionId: string) => {
        resolveDiscussionCalls.push(discussionId);
        return Promise.resolve();
      },
    ),
    resolveDiscussionCalls,
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: vi.fn(
      (_projectId: number, _mrIid: number, discussionId: string) => {
        unresolveDiscussionCalls.push(discussionId);
        return Promise.resolve();
      },
    ),
    unresolveDiscussionCalls,
  } as unknown as ICodeHost & {
    resolveDiscussionCalls: string[];
    unresolveDiscussionCalls: string[];
  };
}

describe("CommentResolutionService", () => {
  describe("resolveStaleFindings", () => {
    it("marks finding as pending when file is not in diff", async () => {
      const finding = makeFinding({ filePath: "src/other.ts" });
      const diff = makeParsedDiff({
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );

      expect(result.pending).toContain("finding-1");
      expect(result.addressed).toHaveLength(0);
      expect(repo.resolutionCalls).toHaveLength(0);
    });

    it("marks finding as addressed when the finding's line was modified (added line changed)", async () => {
      const finding = makeFinding({ lineNumber: 10, lineType: "added" });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );

      expect(result.addressed).toContain("finding-1");
      expect(result.pending).toHaveLength(0);
      expect(repo.resolutionCalls).toEqual([["finding-1", "addressed"]]);
    });

    it("marks finding as addressed when the finding's line was removed", async () => {
      const finding = makeFinding({ lineNumber: 5, lineType: "removed" });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "removed line",
            hunkHeader: "@@ -5,2 +5,1 @@",
            oldLine: 5,
            type: "removed",
          },
        ],
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );

      expect(result.addressed).toContain("finding-1");
      expect(repo.resolutionCalls).toEqual([["finding-1", "addressed"]]);
    });

    it("resolves GitLab discussion when finding has hostDiscussionId", async () => {
      const finding = makeFinding({
        hostDiscussionId: "disc-abc",
        lineNumber: 10,
        lineType: "added",
      });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      await service.resolveStaleFindings([finding], [diff], 1, 42);

      expect(codeHost.resolveDiscussionCalls).toContain("disc-abc");
    });

    it("keeps finding pending when resolveDiscussion fails", async () => {
      const finding = makeFinding({
        hostDiscussionId: "disc-resolve-fail",
        lineNumber: 10,
        lineType: "added",
      });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });
      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      vi.spyOn(codeHost, "resolveDiscussion").mockRejectedValue(
        new Error("resolve failed"),
      );
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );
      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );
      expect(result.addressed).toHaveLength(0);
      expect(result.pending).toContain("finding-1");
      expect(repo.resolutionCalls).toHaveLength(0);
    });

    it("does not call resolveDiscussion when no hostDiscussionId", async () => {
      const finding = makeFinding({
        hostDiscussionId: undefined,
        lineNumber: 10,
        lineType: "added",
      });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      await service.resolveStaleFindings([finding], [diff], 1, 42);

      expect(codeHost.resolveDiscussionCalls).toHaveLength(0);
    });

    it("rolls back discussion resolution when DB update fails", async () => {
      const finding = makeFinding({
        hostDiscussionId: "disc-db-failed",
        lineNumber: 10,
        lineType: "added",
      });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });
      const repo = makeMockRepo();
      vi.spyOn(repo, "updateResolution").mockRejectedValue(
        new Error("db failed"),
      );
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );
      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );
      expect(codeHost.resolveDiscussionCalls).toContain("disc-db-failed");
      expect(codeHost.unresolveDiscussionCalls).toContain("disc-db-failed");
      expect(result.addressed).toHaveLength(0);
      expect(result.pending).toContain("finding-1");
    });

    it("continues when rollback unresolve fails", async () => {
      const finding = makeFinding({
        hostDiscussionId: "disc-rollback-failed",
        lineNumber: 10,
        lineType: "added",
      });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "modified",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            type: "added",
          },
        ],
      });
      const repo = makeMockRepo();
      vi.spyOn(repo, "updateResolution").mockRejectedValue(
        new Error("db failed"),
      );
      const codeHost = makeMockCodeHost();
      vi.spyOn(codeHost, "unresolveDiscussion").mockRejectedValue(
        new Error("rollback failed"),
      );
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );
      await expect(
        service.resolveStaleFindings([finding], [diff], 1, 42),
      ).resolves.toEqual({
        addressed: [],
        pending: ["finding-1"],
      });
    });

    it("keeps finding pending when line is untouched context", async () => {
      const finding = makeFinding({ lineNumber: 10, lineType: "added" });
      const diff = makeParsedDiff({
        lines: [
          {
            content: "unchanged line",
            hunkHeader: "@@ -10,3 +10,3 @@",
            newLine: 10,
            oldLine: 10,
            type: "context",
          },
        ],
      });

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      const result = await service.resolveStaleFindings(
        [finding],
        [diff],
        1,
        42,
      );

      expect(result.pending).toContain("finding-1");
      expect(result.addressed).toHaveLength(0);
      expect(repo.resolutionCalls).toHaveLength(0);
    });

    it("handles multiple findings across multiple diffs", async () => {
      const findings = [
        makeFinding({
          filePath: "src/a.ts",
          id: "f1",
          lineNumber: 3,
          lineType: "added",
        }),
        makeFinding({
          filePath: "src/b.ts",
          id: "f2",
          lineNumber: 7,
          lineType: "added",
        }),
        makeFinding({ filePath: "src/c.ts", id: "f3" }),
      ];

      const diffs = [
        makeParsedDiff({
          lines: [
            {
              content: "x",
              hunkHeader: "@@ -3,1 +3,1 @@",
              newLine: 3,
              type: "added",
            },
          ],
          newPath: "src/a.ts",
          oldPath: "src/a.ts",
        }),
        makeParsedDiff({
          lines: [
            {
              content: "y",
              hunkHeader: "@@ -1,1 +1,1 @@",
              newLine: 1,
              type: "context",
            },
          ],
          newPath: "src/b.ts",
          oldPath: "src/b.ts",
        }),
      ];

      const repo = makeMockRepo();
      const codeHost = makeMockCodeHost();
      const service = new CommentResolutionService(
        repo,
        codeHost,
        createMockLogger(),
      );

      const result = await service.resolveStaleFindings(findings, diffs, 1, 42);

      expect(result.addressed).toContain("f1");
      expect(result.pending).toContain("f2");
      expect(result.pending).toContain("f3");
    });
  });
});
