import { Octokit } from "@octokit/rest";
import type { IConfig } from "~/shared/config";
import { describe, expect, it } from "vitest";

import type { GitHubConfigSchema } from "~/config/github.config";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import { GitHubCodeHost } from "~/infrastructure/code-host/github/github.code-host";
import { createMockLogger } from "~/test-utils/mock-logger";

interface RouteResponse {
  body: unknown;
  contentType?: string;
  status?: number;
}

type RouteHandler = (
  method: string,
  path: string,
  init: RequestInit | undefined,
) => RouteResponse | undefined;

interface RecordedCall {
  body: unknown;
  method: string;
  path: string;
}

function buildHost(handler: RouteHandler): {
  calls: RecordedCall[];
  host: GitHubCodeHost;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlString =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(urlString);
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const parsedBody =
      typeof rawBody === "string" && rawBody.length > 0
        ? (JSON.parse(rawBody) as unknown)
        : undefined;
    calls.push({ body: parsedBody, method, path: url.pathname });

    const result = handler(method, url.pathname, init);
    if (!result) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Not Found" }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      );
    }
    const contentType = result.contentType ?? "application/json";
    const payload =
      contentType === "application/json"
        ? JSON.stringify(result.body)
        : String(result.body);
    return Promise.resolve(
      new Response(payload, {
        headers: { "content-type": contentType },
        status: result.status ?? 200,
      }),
    );
  };

  const octokit = new Octokit({
    auth: "test",
    request: { fetch: fetchImpl },
  });
  const config = {
    envs: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_BOT_USERNAME: "ai",
    },
  } as IConfig<GitHubConfigSchema>;
  const host = new GitHubCodeHost(octokit, config, createMockLogger());
  return { calls, host };
}

const repoResponse: RouteResponse = {
  body: { name: "repo", owner: { login: "owner" } },
};

describe("GitHubCodeHost", () => {
  it("resolves a numeric repo id to owner/repo and caches it", async () => {
    const { calls, host } = buildHost((_method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/pulls/7") {
        return {
          body: {
            base: { ref: "main", sha: "basesha" },
            body: "desc",
            head: { ref: "feature", sha: "headsha" },
            number: 7,
            title: "My PR",
          },
        };
      }
      return undefined;
    });

    const first = await host.getMergeRequestInfo(42, 7);
    const second = await host.getMergeRequestInfo(42, 7);

    expect(first).toEqual({
      description: "desc",
      iid: 7,
      projectId: 42,
      sourceBranch: "feature",
      targetBranch: "main",
      title: "My PR",
    });
    expect(second).toEqual(first);
    // resolveRepo cached: /repositories/42 hit exactly once across both calls.
    expect(calls.filter((c) => c.path === "/repositories/42")).toHaveLength(1);
  });

  it("maps pull request files to DiffFile entries", async () => {
    const { host } = buildHost((_method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/pulls/7/files") {
        return {
          body: [
            { filename: "src/a.ts", patch: "@@ -1 +1 @@" },
            {
              filename: "src/b.ts",
              patch: "@@ -2 +2 @@",
              previous_filename: "src/old.ts",
            },
          ],
        };
      }
      return undefined;
    });

    const diffs = await host.getMergeRequestDiff(42, 7);
    expect(diffs).toEqual([
      { diff: "@@ -1 +1 @@", newPath: "src/a.ts", oldPath: "src/a.ts" },
      { diff: "@@ -2 +2 @@", newPath: "src/b.ts", oldPath: "src/old.ts" },
    ]);
  });

  it("throws CodeHostNotFoundError when a file is missing", async () => {
    const { host } = buildHost((_method, path) => {
      if (path === "/repositories/42") return repoResponse;
      return undefined; // contents path 404s
    });

    await expect(
      host.getFileContent(42, "headsha", "missing.ts"),
    ).rejects.toBeInstanceOf(CodeHostNotFoundError);
  });

  it("posts an inline comment with right-side line metadata", async () => {
    const { calls, host } = buildHost((method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/pulls/7/comments" && method === "POST") {
        return { body: { id: 999 }, status: 201 };
      }
      return undefined;
    });

    const result = await host.postInlineComment(42, 7, "nit", {
      baseSha: "b",
      headSha: "h",
      newLine: 12,
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      positionType: "text",
      startSha: "s",
    });

    expect(result).toEqual({ discussionId: "999", noteId: "999" });
    const post = calls.find(
      (c) => c.path === "/repos/owner/repo/pulls/7/comments",
    );
    expect(post?.body).toMatchObject({
      commit_id: "h",
      line: 12,
      path: "src/a.ts",
      side: "RIGHT",
    });
  });

  it("posts a pull-request level note", async () => {
    const { host } = buildHost((method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/issues/7/comments" && method === "POST") {
        return { body: { id: 321 }, status: 201 };
      }
      return undefined;
    });

    const result = await host.postNote(42, 7, "summary");
    expect(result).toEqual({ noteId: "321" });
  });

  it("resolves a review thread via GraphQL", async () => {
    const { calls, host } = buildHost((method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/graphql" && method === "POST") {
        return {
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        comments: { nodes: [{ databaseId: 555 }] },
                        id: "THREAD_1",
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }
      return undefined;
    });

    await host.resolveDiscussion(42, 7, "555");
    const graphqlCalls = calls.filter((c) => c.path === "/graphql");
    // One query to locate the thread, one mutation to resolve it.
    expect(graphqlCalls).toHaveLength(2);
  });
});
