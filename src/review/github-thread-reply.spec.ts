import { describe, expect, it, vi } from "vitest";

import { answerThreadWithCodeHost } from "~/review/github-thread-reply";

function host() {
  return {
    getRepoId: vi.fn(() => Promise.resolve(42)),
    replyToDiscussion: vi.fn(() => Promise.resolve({ noteId: "n1" })),
  };
}

describe("answerThreadWithCodeHost", () => {
  it("posts the rule reply without calling a model", async () => {
    const codeHost = host();
    const result = await answerThreadWithCodeHost(codeHost, {
      catalogUrl: "https://rules.example.com/rules",
      finding: { filePath: "a.ts", line: 1, ruleId: "R-013" },
      owner: "o",
      pullRequestNumber: 5,
      replyToCommentId: "c1",
      repo: "r",
    });
    expect(result.posted).toBe(true);
    expect(codeHost.replyToDiscussion).toHaveBeenCalledWith(
      42,
      5,
      "c1",
      expect.stringContaining("Rule R-013:"),
    );
  });

  it("names the given product in the posted reply", async () => {
    const codeHost = host();
    const result = await answerThreadWithCodeHost(codeHost, {
      finding: { filePath: "a.ts", line: 1, ruleId: "R-013" },
      owner: "o",
      productName: "Acme",
      pullRequestNumber: 5,
      replyToCommentId: "c1",
      repo: "r",
    });
    expect(result.answer.startsWith("Acme is an automated check")).toBe(true);
    expect(codeHost.replyToDiscussion).toHaveBeenCalledWith(
      42,
      5,
      "c1",
      result.answer,
    );
  });

  it("stays silent on a thread without a catalog rule", async () => {
    const codeHost = host();
    const result = await answerThreadWithCodeHost(codeHost, {
      finding: { filePath: "a.ts", line: 1, ruleId: null },
      owner: "o",
      pullRequestNumber: 5,
      replyToCommentId: "c1",
      repo: "r",
    });
    expect(result).toEqual({ answer: "", posted: false });
    expect(codeHost.replyToDiscussion).not.toHaveBeenCalled();
  });
});
