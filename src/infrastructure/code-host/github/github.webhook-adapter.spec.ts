import { describe, expect, it } from "vitest";

import { parseGitHubWebhook } from "~/infrastructure/code-host/github/github.webhook-adapter";

function pullRequestBody(
  action: string,
  overrides: { draft?: boolean; before?: string } = {},
): unknown {
  return {
    action,
    before: overrides.before,
    number: 7,
    pull_request: {
      base: { ref: "main" },
      draft: overrides.draft ?? false,
      head: { ref: "feature", sha: "headsha" },
    },
    repository: { id: 42 },
  };
}

describe("parseGitHubWebhook — pull_request", () => {
  it("maps opened (non-draft) to mr_open", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("opened"),
    );
    expect(result).toEqual({
      event: { headSha: "headsha", mrIid: 7, projectId: 42, type: "mr_open" },
      kind: "event",
    });
  });

  it("ignores opened draft pull requests", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("opened", { draft: true }),
    );
    expect(result).toEqual({ kind: "ignored", reason: "draft_merge_request" });
  });

  it("maps reopened to mr_open", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("reopened"),
    );
    expect(result.kind).toBe("event");
  });

  it("maps ready_for_review to mr_undraft", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("ready_for_review"),
    );
    expect(result).toEqual({
      event: {
        headSha: "headsha",
        mrIid: 7,
        projectId: 42,
        type: "mr_undraft",
      },
      kind: "event",
    });
  });

  it("maps synchronize to mr_update carrying the previous head sha", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("synchronize", { before: "prevsha" }),
    );
    expect(result).toEqual({
      event: {
        headSha: "headsha",
        mrIid: 7,
        previousHeadSha: "prevsha",
        projectId: 42,
        type: "mr_update",
      },
      kind: "event",
    });
  });

  it("ignores synchronize on a draft", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("synchronize", { draft: true }),
    );
    expect(result).toEqual({ kind: "ignored", reason: "draft_merge_request" });
  });

  it("ignores closed pull requests as terminal", () => {
    const result = parseGitHubWebhook(
      "pull_request",
      pullRequestBody("closed"),
    );
    expect(result).toEqual({
      kind: "ignored",
      reason: "merge_request_terminal",
    });
  });
});

describe("parseGitHubWebhook — comments", () => {
  it("maps an issue comment on a pull request to a note", () => {
    const result = parseGitHubWebhook("issue_comment", {
      action: "created",
      comment: { body: "@ai review", user: { login: "dev" } },
      issue: { number: 9, pull_request: {} },
      repository: { id: 42 },
    });
    expect(result).toEqual({
      event: {
        authorUsername: "dev",
        mrIid: 9,
        note: "@ai review",
        projectId: 42,
        type: "note",
      },
      kind: "event",
    });
  });

  it("treats an issue comment on a non-PR issue as invalid", () => {
    const result = parseGitHubWebhook("issue_comment", {
      action: "created",
      comment: { body: "hi", user: { login: "dev" } },
      issue: { number: 9 },
      repository: { id: 42 },
    });
    expect(result).toEqual({ kind: "invalid" });
  });

  it("maps a review comment (RIGHT) to an anchored note", () => {
    const result = parseGitHubWebhook("pull_request_review_comment", {
      action: "created",
      comment: {
        body: "nit",
        id: 555,
        line: 12,
        path: "src/a.ts",
        side: "RIGHT",
        user: { login: "dev" },
      },
      pull_request: { draft: false, number: 9 },
      repository: { id: 42 },
    });
    expect(result).toEqual({
      event: {
        authorUsername: "dev",
        discussionId: "555",
        mrIid: 9,
        note: "nit",
        position: {
          newLine: 12,
          newPath: "src/a.ts",
          oldLine: undefined,
          oldPath: undefined,
        },
        projectId: 42,
        type: "note",
      },
      kind: "event",
    });
  });

  it("uses in_reply_to_id as the discussion id for replies", () => {
    const result = parseGitHubWebhook("pull_request_review_comment", {
      action: "created",
      comment: {
        body: "reply",
        id: 556,
        in_reply_to_id: 555,
        line: 12,
        path: "src/a.ts",
        side: "RIGHT",
        user: { login: "dev" },
      },
      pull_request: { number: 9 },
      repository: { id: 42 },
    });
    expect(result.kind).toBe("event");
    if (result.kind === "event" && result.event.type === "note") {
      expect(result.event.discussionId).toBe("555");
    }
  });

  it("maps a review comment on the LEFT side to old-side position", () => {
    const result = parseGitHubWebhook("pull_request_review_comment", {
      action: "created",
      comment: {
        body: "old",
        id: 1,
        line: 4,
        path: "src/a.ts",
        side: "LEFT",
        user: { login: "dev" },
      },
      pull_request: { number: 9 },
      repository: { id: 42 },
    });
    if (result.kind === "event" && result.event.type === "note") {
      expect(result.event.position).toEqual({
        newLine: undefined,
        newPath: undefined,
        oldLine: 4,
        oldPath: "src/a.ts",
      });
    }
  });
});

describe("parseGitHubWebhook — push and invalid", () => {
  it("maps a push event", () => {
    const result = parseGitHubWebhook("push", {
      after: "newsha",
      before: "oldsha",
      commits: [{ added: ["a.ts"], modified: [], removed: [] }],
      ref: "refs/heads/main",
      repository: { id: 42 },
    });
    expect(result).toEqual({
      event: {
        afterSha: "newsha",
        beforeSha: "oldsha",
        commits: [{ added: ["a.ts"], modified: [], removed: [] }],
        projectId: 42,
        ref: "refs/heads/main",
        type: "push",
      },
      kind: "event",
    });
  });

  it("returns invalid for an unknown event name", () => {
    expect(parseGitHubWebhook("ping", {})).toEqual({ kind: "invalid" });
  });

  it("returns invalid for a malformed pull_request body", () => {
    expect(parseGitHubWebhook("pull_request", { action: "opened" })).toEqual({
      kind: "invalid",
    });
  });
});
