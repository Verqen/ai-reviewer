import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeGitLabServer,
  loadFixture,
} from "~/test-utils/fake-gitlab-server";
import type { FakeGitLabServer } from "~/test-utils/fake-gitlab-server";

let server: FakeGitLabServer;

let baseUrl: string;

beforeAll(async () => {
  server = createFakeGitLabServer();
  baseUrl = await server.start();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  server.reset();
});

describe("FakeGitLabServer", () => {
  it("returns project info", async () => {
    const response = await fetch(`${baseUrl}projects/42`);
    const data = (await response.json()) as { default_branch: string };
    expect(response.ok).toBe(true);
    expect(data.default_branch).toBe("main");
  });

  it("returns MR info", async () => {
    const response = await fetch(`${baseUrl}projects/42/merge_requests/7`);
    const data = (await response.json()) as { title: string };
    expect(response.ok).toBe(true);
    expect(data.title).toBe("Add user authentication");
  });

  it("returns MR changes", async () => {
    const response = await fetch(
      `${baseUrl}projects/42/merge_requests/7/changes`,
    );
    const data = (await response.json()) as { changes: unknown[] };
    expect(response.ok).toBe(true);
    expect(data.changes.length).toBeGreaterThan(0);
  });

  it("returns MR versions", async () => {
    const response = await fetch(
      `${baseUrl}projects/42/merge_requests/7/versions`,
    );
    const data = (await response.json()) as unknown[];
    expect(response.ok).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("records posted discussions", async () => {
    const response = await fetch(
      `${baseUrl}projects/42/merge_requests/7/discussions`,
      {
        body: JSON.stringify({
          body: "Test comment",
          position: { file_path: "test.ts", new_line: 10 },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(response.ok).toBe(true);
    const comments = server.getPostedComments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("Test comment");
  });

  it("records posted notes", async () => {
    await fetch(`${baseUrl}projects/42/merge_requests/7/notes`, {
      body: JSON.stringify({ body: "A summary note" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const notes = server.getPostedNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("A summary note");
  });

  it("tracks approvals and unapprovals", async () => {
    await fetch(`${baseUrl}projects/42/merge_requests/7/approve`, {
      method: "POST",
    });

    expect(server.isApproved(42, 7)).toBe(true);
    expect(server.getApprovalActions()).toEqual([
      { action: "approve", mrIid: 7, projectId: 42 },
    ]);

    await fetch(`${baseUrl}projects/42/merge_requests/7/unapprove`, {
      method: "POST",
    });

    expect(server.isApproved(42, 7)).toBe(false);
    expect(server.getApprovalActions()).toEqual([
      { action: "approve", mrIid: 7, projectId: 42 },
      { action: "unapprove", mrIid: 7, projectId: 42 },
    ]);
  });

  it("reset clears all recorded data", async () => {
    await fetch(`${baseUrl}projects/42/merge_requests/7/notes`, {
      body: JSON.stringify({ body: "Note" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    await fetch(`${baseUrl}projects/42/merge_requests/7/approve`, {
      method: "POST",
    });

    server.reset();
    expect(server.getPostedNotes()).toHaveLength(0);
    expect(server.getPostedComments()).toHaveLength(0);
    expect(server.getApprovalActions()).toHaveLength(0);
    expect(server.isApproved(42, 7)).toBe(false);
  });

  it("loadFixture loads fixture data", () => {
    const fixture = loadFixture<{ object_kind: string }>("mr-open");
    expect(fixture.object_kind).toBe("merge_request");
  });
});
