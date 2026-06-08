import { Octokit } from "@octokit/rest";
import type { IConfig } from "~/shared/config";
import { describe, expect, it } from "vitest";

import type { GitHubConfigSchema } from "~/config/github.config";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import {
  GitHubCodeHost,
  listInstallationRepositories,
} from "~/infrastructure/code-host/github/github.code-host";
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
  octokit: Octokit;
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
    const response = new Response(payload, {
      headers: { "content-type": contentType },
      status: result.status ?? 200,
    });
    Object.defineProperty(response, "url", { value: urlString });
    return Promise.resolve(response);
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
  return { calls, host, octokit };
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
      return undefined;
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

  it("creates a fresh note when no marked bot comment exists yet", async () => {
    const { calls, host } = buildHost((method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/issues/7/comments" && method === "GET") {
        return { body: [] };
      }
      if (path === "/repos/owner/repo/issues/7/comments" && method === "POST") {
        return { body: { id: 100 }, status: 201 };
      }
      return undefined;
    });

    const result = await host.upsertNote(42, 7, "body", "<!-- m -->");
    expect(result).toEqual({ noteId: "100" });
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/repos/owner/repo/issues/7/comments",
      ),
    ).toBe(true);
  });

  it("deletes every prior marked summary and reposts a fresh one at the bottom", async () => {
    const { calls, host } = buildHost((method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/issues/7/comments" && method === "GET") {
        return {
          body: [
            {
              body: "old summary\n<!-- m -->",
              id: 555,
              user: { login: "ai", type: "User" },
            },
            {
              body: "even older summary\n<!-- m -->",
              id: 556,
              user: { login: "ai", type: "User" },
            },
          ],
        };
      }
      if (path === "/repos/owner/repo/issues/7/comments" && method === "POST") {
        return { body: { id: 700 }, status: 201 };
      }
      if (
        (path === "/repos/owner/repo/issues/comments/555" ||
          path === "/repos/owner/repo/issues/comments/556") &&
        method === "DELETE"
      ) {
        return { body: {}, status: 200 };
      }
      return undefined;
    });

    const result = await host.upsertNote(42, 7, "new body", "<!-- m -->");
    expect(result).toEqual({ noteId: "700" });
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.path).sort()).toEqual([
      "/repos/owner/repo/issues/comments/555",
      "/repos/owner/repo/issues/comments/556",
    ]);
    const post = calls.find(
      (c) =>
        c.method === "POST" && c.path === "/repos/owner/repo/issues/7/comments",
    );
    expect(post?.body).toMatchObject({ body: "new body" });
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
    expect(graphqlCalls).toHaveLength(2);
  });

  it("resolves a numeric repo id from owner and repo without a directory lookup", async () => {
    const { calls, host } = buildHost((_method, path) => {
      if (path === "/repos/owner/repo") return { body: { id: 4242 } };
      return undefined;
    });

    const repoId = await host.getRepoId("owner", "repo");

    expect(repoId).toBe(4242);
    expect(calls.some((c) => c.path === "/repositories/4242")).toBe(false);
  });

  it("collects only the bot's own review-comment locations, both current and original lines", async () => {
    const { host } = buildHost((_method, path) => {
      if (path === "/repositories/42") return repoResponse;
      if (path === "/repos/owner/repo/pulls/7/comments") {
        return {
          body: [
            {
              line: 10,
              original_line: 8,
              path: "src/a.ts",
              user: { login: "ai", type: "User" },
            },
            {
              line: 20,
              original_line: null,
              path: "src/b.ts",
              user: { login: "octo[bot]", type: "Bot" },
            },
            {
              line: 30,
              original_line: 30,
              path: "src/c.ts",
              user: { login: "human", type: "User" },
            },
            {
              line: null,
              original_line: null,
              path: "src/d.ts",
              user: { login: "ai", type: "User" },
            },
          ],
        };
      }
      return undefined;
    });

    const locations = await host.listOwnReviewCommentLocations(42, 7);

    expect(locations).toEqual([
      { line: 10, path: "src/a.ts" },
      { line: 8, path: "src/a.ts" },
      { line: 20, path: "src/b.ts" },
    ]);
  });

  it("maps installation repositories to their domain info shape", async () => {
    const { octokit } = buildHost((_method, path) => {
      if (path === "/installation/repositories") {
        return {
          body: {
            repositories: [
              {
                default_branch: "main",
                full_name: "owner/repo",
                id: 1,
                private: true,
              },
              {
                default_branch: "dev",
                full_name: "owner/other",
                id: 2,
                private: false,
              },
            ],
            total_count: 2,
          },
        };
      }
      return undefined;
    });

    const repositories = await listInstallationRepositories(octokit);

    expect(repositories).toEqual([
      { defaultBranch: "main", fullName: "owner/repo", id: 1, isPrivate: true },
      {
        defaultBranch: "dev",
        fullName: "owner/other",
        id: 2,
        isPrivate: false,
      },
    ]);
  });
});
