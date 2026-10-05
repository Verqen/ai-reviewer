import type { IConfig } from "~/shared/config";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GitLabConfigSchema } from "~/config/gitlab.config";
import { GitLabCodeHost } from "~/infrastructure/code-host/gitlab/gitlab.code-host";
import { createMockLogger } from "~/test-utils/mock-logger";

interface FixtureResponses {
  changes?: unknown;
  compare?: unknown;
}

function makeChangeFixture(newPath: string): {
  diff: string;
  new_path: string;
  old_path: string;
} {
  return {
    diff: `@@ -1,1 +1,1 @@\n-old\n+new ${newPath}\n`,
    new_path: newPath,
    old_path: newPath,
  };
}

function buildConfig(apiUrl: string): IConfig<GitLabConfigSchema> {
  return {
    envs: {
      GITLAB_API_URL: apiUrl,
      GITLAB_BOT_USERNAME: "ai",
      GITLAB_TOKEN: "test-token",
    },
  };
}

describe("GitLabCodeHost.getMergeRequestDiff", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let responses: FixtureResponses;

  beforeEach(async () => {
    responses = {};
    app = Fastify({ logger: false });

    app.get(
      "/projects/:projectId/merge_requests/:mrIid/changes",
      (_req, reply) => reply.send(responses.changes),
    );
    app.get("/projects/:projectId/repository/compare", (_req, reply) =>
      reply.send(responses.compare),
    );

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = address.replace(/\/$/, "");
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns truncated changes as-is when overflow is false", async () => {
    responses.changes = {
      changes: [makeChangeFixture("a.ts"), makeChangeFixture("b.ts")],
      changes_count: "2",
      diff_refs: {
        base_sha: "base",
        head_sha: "head",
        start_sha: "start",
      },
      overflow: false,
    };

    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const diffs = await codeHost.getMergeRequestDiff(42, 7);

    expect(diffs).toHaveLength(2);
    expect(diffs.map((d) => d.newPath)).toEqual(["a.ts", "b.ts"]);
  });

  it("falls back to /repository/compare when overflow=true and recovers full diff", async () => {
    responses.changes = {
      changes: [makeChangeFixture("a.ts"), makeChangeFixture("b.ts")],
      changes_count: "5",
      diff_refs: {
        base_sha: "base-sha",
        head_sha: "head-sha",
        start_sha: "start-sha",
      },
      overflow: true,
    };
    responses.compare = {
      diffs: [
        makeChangeFixture("a.ts"),
        makeChangeFixture("b.ts"),
        makeChangeFixture("c.ts"),
        makeChangeFixture("d.ts"),
        makeChangeFixture("e.ts"),
      ],
    };

    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const diffs = await codeHost.getMergeRequestDiff(42, 7);

    expect(diffs).toHaveLength(5);
    expect(diffs.map((d) => d.newPath)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ]);
  });

  it("falls back when changes_count exceeds returned count even if overflow flag is missing", async () => {
    responses.changes = {
      changes: [makeChangeFixture("a.ts")],
      changes_count: "3",
      diff_refs: {
        base_sha: "base-sha",
        head_sha: "head-sha",
        start_sha: "start-sha",
      },
    };
    responses.compare = {
      diffs: [
        makeChangeFixture("a.ts"),
        makeChangeFixture("b.ts"),
        makeChangeFixture("c.ts"),
      ],
    };

    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const diffs = await codeHost.getMergeRequestDiff(42, 7);

    expect(diffs).toHaveLength(3);
  });

  it("returns truncated set when overflow=true but diff_refs missing (cannot fall back)", async () => {
    responses.changes = {
      changes: [makeChangeFixture("a.ts")],
      changes_count: "5",
      overflow: true,
    };

    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const diffs = await codeHost.getMergeRequestDiff(42, 7);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.newPath).toBe("a.ts");
  });
});

describe("GitLabCodeHost upstream failures", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const upstreamBody = "x".repeat(20_000);

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.get(
      "/projects/:projectId/merge_requests/:mrIid/changes",
      (_req, reply) => reply.status(403).send(upstreamBody),
    );
    app.get("/projects/:projectId/repository/files/:path/raw", (_req, reply) =>
      reply.status(403).send(upstreamBody),
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = address.replace(/\/$/, "");
  });

  afterEach(async () => {
    await app.close();
  });

  async function captureMessage(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the call to fail");
  }

  it("bounds the upstream body carried by an API error", async () => {
    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const message = await captureMessage(() =>
      codeHost.getMergeRequestDiff(42, 7),
    );

    expect(message).toMatch(/^GitLab API error: 403 /);
    expect(message.length).toBeLessThan(1_000);
  });

  it("bounds the upstream body carried by a file content error", async () => {
    const codeHost = new GitLabCodeHost(
      buildConfig(baseUrl),
      createMockLogger(),
    );

    const message = await captureMessage(() =>
      codeHost.getFileContent(42, "main", "a.ts"),
    );

    expect(message).toMatch(/^GitLab API error: 403 /);
    expect(message.length).toBeLessThan(1_000);
  });
});
