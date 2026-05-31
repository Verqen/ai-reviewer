import { describe, expect, it } from "vitest";

import {
  parseGitLabWebhook,
  type GitlabWebhookParseResult,
} from "~/infrastructure/code-host/gitlab/gitlab.webhook-adapter";
import { loadFixture } from "~/test-utils/fake-gitlab-server";

function expectEventPayload(result: GitlabWebhookParseResult) {
  expect(result.kind).toBe("event");
  if (result.kind !== "event") {
    throw new Error("expected event payload");
  }
  return result.event;
}

function expectIgnoredDraft(result: GitlabWebhookParseResult) {
  expect(result).toEqual({
    kind: "ignored",
    reason: "draft_merge_request",
  });
}

function expectIgnoredTerminal(result: GitlabWebhookParseResult) {
  expect(result).toEqual({
    kind: "ignored",
    reason: "merge_request_terminal",
  });
}

describe("parseGitLabWebhook", () => {
  it("parses MR open event", () => {
    const payload = loadFixture<unknown>("mr-open");
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("mr_open");

    if (event.type === "mr_open") {
      expect(event.projectId).toBe(42);
      expect(event.mrIid).toBe(7);
      expect(event.headSha).toBe("abc123def456abc123def456abc123def456abc1");
    }
  });

  it("parses note mention event when merge_request.draft is false", () => {
    const payload = loadFixture<unknown>("note-mention");
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("note");

    if (event.type === "note") {
      expect(event.projectId).toBe(42);
      expect(event.mrIid).toBe(7);
      expect(event.authorUsername).toBe("developer1");
      expect(event.note).toContain("@ai");
      expect(event.discussionId).toBe("disc-abc123");
      expect(event.position?.newPath).toBe("src/services/user.service.ts");
      expect(event.position?.newLine).toBe(13);
    }
  });

  it("ignores note when merge_request.draft is not false", () => {
    const parsed = parseGitLabWebhook({
      merge_request: { draft: true, iid: 7 },
      object_attributes: {
        note: "@ai help",
        noteable_type: "MergeRequest",
      },
      object_kind: "note",
      project: { id: 10 },
      user: { username: "u" },
    });
    expectIgnoredDraft(parsed);
  });

  it("ignores note when merge_request has no draft field", () => {
    const parsed = parseGitLabWebhook({
      merge_request: { iid: 7 },
      object_attributes: {
        note: "@ai help",
        noteable_type: "MergeRequest",
      },
      object_kind: "note",
      project: { id: 10 },
      user: { username: "u" },
    });
    expectIgnoredDraft(parsed);
  });

  it("parses push event", () => {
    const payload = loadFixture<unknown>("push-default-branch");
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("push");

    if (event.type === "push") {
      expect(event.projectId).toBe(42);
      expect(event.ref).toBe("refs/heads/main");
      expect(event.afterSha).toBe("fff999eeedddcccbbbaaaa888777666555444333");
      expect(event.commits).toHaveLength(2);
    }
  });

  it("parses MR undraft event", () => {
    const payload = {
      changes: {
        draft: { current: false, previous: true },
      },
      object_attributes: {
        action: "update",
        iid: 3,
        last_commit: { id: "sha1" },
      },
      object_kind: "merge_request",
      project: { id: 10 },
    };
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("mr_undraft");
  });

  it("parses MR update event", () => {
    const payload = {
      object_attributes: {
        action: "update",
        draft: false,
        iid: 3,
        last_commit: { id: "sha1" },
        oldrev: "sha0",
      },
      object_kind: "merge_request",
      project: { id: 10 },
    };
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("mr_update");
    if (event.type === "mr_update") {
      expect(event.previousHeadSha).toBe("sha0");
    }
  });

  it("ignores MR close without last_commit", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "close",
        iid: 3,
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredTerminal(parsed);
  });

  it("ignores MR close with last_commit", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "close",
        iid: 3,
        last_commit: { id: "sha1" },
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredTerminal(parsed);
  });

  it("ignores MR merge without last_commit", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "merge",
        iid: 3,
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredTerminal(parsed);
  });

  it("ignores MR update when state is merged without last_commit", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "update",
        iid: 3,
        state: "merged",
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredTerminal(parsed);
  });

  it("ignores MR update when state is closed without last_commit", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "update",
        iid: 3,
        state: "closed",
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredTerminal(parsed);
  });

  it("parses MR update when state is opened", () => {
    const payload = {
      object_attributes: {
        action: "update",
        draft: false,
        iid: 3,
        last_commit: { id: "sha1" },
        state: "opened",
      },
      object_kind: "merge_request",
      project: { id: 10 },
    };
    const parsed = parseGitLabWebhook(payload);
    const event = expectEventPayload(parsed);
    expect(event.type).toBe("mr_update");
  });

  it("ignores MR open when draft is true", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "open",
        draft: true,
        iid: 1,
        last_commit: { id: "sha1" },
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredDraft(parsed);
  });

  it("ignores MR open when work_in_progress is true", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "open",
        iid: 1,
        last_commit: { id: "sha1" },
        work_in_progress: true,
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredDraft(parsed);
  });

  it("ignores MR update while still draft", () => {
    const parsed = parseGitLabWebhook({
      object_attributes: {
        action: "update",
        draft: true,
        iid: 3,
        last_commit: { id: "sha2" },
      },
      object_kind: "merge_request",
      project: { id: 10 },
    });
    expectIgnoredDraft(parsed);
  });

  it("returns invalid for unknown event kind", () => {
    const parsed = parseGitLabWebhook({ object_kind: "pipeline" });
    expect(parsed.kind).toBe("invalid");
  });

  it("returns invalid for invalid payload", () => {
    expect(parseGitLabWebhook(null).kind).toBe("invalid");
    expect(parseGitLabWebhook(undefined).kind).toBe("invalid");
    expect(parseGitLabWebhook("string").kind).toBe("invalid");
    expect(parseGitLabWebhook({}).kind).toBe("invalid");
  });

  it("returns invalid for note without merge_request", () => {
    const payload = {
      merge_request: null,
      object_attributes: {
        note: "@ai help",
        noteable_type: "Issue",
      },
      object_kind: "note",
      project: { id: 10 },
      user: { username: "user1" },
    };
    const parsed = parseGitLabWebhook(payload);
    expect(parsed.kind).toBe("invalid");
  });
});
