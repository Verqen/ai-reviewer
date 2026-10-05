import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitHubSource } from "~/infrastructure/archive/public-repository-source";
import {
  fetchGitHubRepository,
  parseRepositoryTarget,
  readDirectoryArchive,
} from "~/infrastructure/archive/public-repository-source";
import { buildTarGzFixture } from "~/test-utils/tar-gz-fixture";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

interface RecordedRequest {
  headers: Record<string, string>;
  url: string;
}

async function fakeGitHub(
  token: string | undefined,
  shaStatus = 200,
): Promise<{ requests: RecordedRequest[]; source: GitHubSource }> {
  const tarball = await buildTarGzFixture([
    { content: "export {};\n", name: "owner-repo-0123456/src/index.ts" },
  ]);
  const requests: RecordedRequest[] = [];
  const fakeFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({ headers: init?.headers as Record<string, string>, url });
    if (url.includes("/commits/")) {
      return Promise.resolve(new Response(COMMIT_SHA, { status: shaStatus }));
    }
    return Promise.resolve(new Response(tarball, { status: 200 }));
  };
  return {
    requests,
    source: { apiUrl: "https://api.example.com", fetch: fakeFetch, token },
  };
}

describe("parseRepositoryTarget", () => {
  it("reads owner/repo with an optional ref", () => {
    expect(parseRepositoryTarget("owner/repo", null)).toEqual({
      kind: "github",
      owner: "owner",
      ref: null,
      repo: "repo",
    });
    expect(parseRepositoryTarget("owner/repo@feature/x", null)).toEqual({
      kind: "github",
      owner: "owner",
      ref: "feature/x",
      repo: "repo",
    });
  });

  it("takes an existing directory or .tar.gz file as a local source", () => {
    expect(parseRepositoryTarget("some/dir", "directory")).toEqual({
      kind: "directory",
      path: "some/dir",
    });
    expect(parseRepositoryTarget("repo.tgz", "file")).toEqual({
      kind: "tarball",
      path: "repo.tgz",
    });
  });

  it("refuses a local file that is not a tar.gz and an unparseable target", () => {
    expect(() => parseRepositoryTarget("notes.txt", "file")).toThrow(/tar\.gz/);
    expect(() => parseRepositoryTarget("not a repo", null)).toThrow(
      /owner\/repo/,
    );
  });
});

describe("readDirectoryArchive", () => {
  let root = "";

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("reads every file with a posix relative path and leaves out .git", async () => {
    root = await mkdtemp(join(tmpdir(), "public-scan-"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "src", "nested", "a.ts"), "export {};\n");
    await writeFile(join(root, "README.md"), "# Title\n");
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

    const entries = await readDirectoryArchive(root);

    expect(entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/nested/a.ts",
    ]);
  });
});

describe("fetchGitHubRepository", () => {
  it("resolves the ref to a commit and downloads that commit without a token", async () => {
    const { requests, source } = await fakeGitHub(undefined);

    const fetched = await fetchGitHubRepository(source, {
      owner: "owner",
      ref: "main",
      repo: "repo",
    });

    expect(fetched.commitSha).toBe(COMMIT_SHA);
    expect(fetched.repository).toBe("owner/repo");
    expect(fetched.archive.map((entry) => entry.path)).toEqual([
      "src/index.ts",
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.example.com/repos/owner/repo/commits/main",
      `https://api.example.com/repos/owner/repo/tarball/${COMMIT_SHA}`,
    ]);
    for (const request of requests) {
      expect(request.headers["Authorization"]).toBeUndefined();
    }
  });

  it("takes the default branch head when no ref is given", async () => {
    const { requests, source } = await fakeGitHub(undefined);

    await fetchGitHubRepository(source, {
      owner: "owner",
      ref: null,
      repo: "repo",
    });

    expect(requests[0]?.url).toBe(
      "https://api.example.com/repos/owner/repo/commits/HEAD",
    );
  });

  it("sends a configured token on every request", async () => {
    const { requests, source } = await fakeGitHub("read-only-token");

    await fetchGitHubRepository(source, {
      owner: "owner",
      ref: null,
      repo: "repo",
    });

    expect(requests.map((request) => request.headers["Authorization"])).toEqual(
      ["Bearer read-only-token", "Bearer read-only-token"],
    );
  });

  it("fails on a ref GitHub does not know", async () => {
    const { source } = await fakeGitHub(undefined, 404);

    await expect(
      fetchGitHubRepository(source, {
        owner: "owner",
        ref: "missing",
        repo: "repo",
      }),
    ).rejects.toThrow(/404/);
  });
});
