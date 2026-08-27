import { describe, expect, it } from "vitest";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import { createMockLogger } from "~/test-utils/mock-logger";

import { ReviewConfigLoader } from "./review-config.loader";

function makeCodeHost(
  options: {
    reviewMd?: string | null;
  } = {},
): ICodeHost {
  return {
    approveMergeRequest: () => Promise.resolve(),
    getBranchHeadSha: () => Promise.resolve("abc123"),
    getCommitRangeDiff: () => Promise.resolve([]),
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: (
      _projectId: number,
      _ref: string,
      path: string,
    ): Promise<string> => {
      if (path === "REVIEW.md") {
        if (options.reviewMd === null) {
          return Promise.reject(
            new CodeHostNotFoundError("REVIEW.md not found"),
          );
        }
        if (options.reviewMd !== undefined) {
          return Promise.resolve(options.reviewMd);
        }
        return Promise.reject(new CodeHostNotFoundError("REVIEW.md not found"));
      }
      return Promise.reject(new CodeHostNotFoundError("not found"));
    },
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
    getRepositoryArchive: () => Promise.resolve([]),
    listOpenMergeRequests: () => Promise.resolve([]),
    postInlineComment: () =>
      Promise.resolve({ discussionId: "d", noteId: "n" }),
    postNote: () => Promise.resolve({ noteId: "n" }),
    replyToDiscussion: () => Promise.resolve({ noteId: "n" }),
    resolveDiscussion: () => Promise.resolve(),
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: () => Promise.resolve(),
  };
}

describe("ReviewConfigLoader", () => {
  describe("fallback chain", () => {
    it("loads REVIEW.md from repo when available", async () => {
      const codeHost = makeCodeHost({
        reviewMd: "## Custom rules\nCheck everything.",
      });
      const loader = new ReviewConfigLoader(codeHost, createMockLogger());

      const config = await loader.load(1, "abc");

      expect(config.rulesSource).toBe("REVIEW.md (repo)");
      expect(config.pathRules).toHaveLength(1);
      expect(config.pathRules?.[0]?.path).toBe("**");
      expect(config.pathRules?.[0]?.extraRules).toContain("Custom rules");
      expect(config.modelOverrides.review).toBe(false);
      expect(config.modelOverrides.triage).toBe(false);
      expect(config).not.toHaveProperty("severityThreshold");
    });

    it("returns REVIEW.md (local) source when repo REVIEW.md is absent", async () => {
      const codeHost = makeCodeHost({});
      const loader = new ReviewConfigLoader(codeHost, createMockLogger());

      const config = await loader.load(1, "abc");

      expect(config.rulesSource).toBe("REVIEW.md (local)");
      expect(config).not.toHaveProperty("severityThreshold");
    });
  });
});
