import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { ArchiveEntry } from "~/domain/types/code-host.types";
import { extractTarGzArchive } from "~/infrastructure/archive/tar-gz-archive";

type RepositoryTarget =
  | { kind: "directory"; path: string }
  | { kind: "github"; owner: string; repo: string; ref: string | null }
  | { kind: "tarball"; path: string };

interface FetchedRepository {
  archive: ArchiveEntry[];
  commitSha: string | null;
  repository: string;
}

interface GitHubSource {
  apiUrl: string;
  fetch: typeof fetch;
  token: string | undefined;
}

const GITHUB_TARGET = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/;
const TARBALL_SUFFIX = /\.(?:tar\.gz|tgz)$/;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git"]);

function parseRepositoryTarget(
  input: string,
  localKind: "directory" | "file" | null,
): RepositoryTarget {
  if (localKind === "directory") return { kind: "directory", path: input };
  if (localKind === "file") {
    if (!TARBALL_SUFFIX.test(input)) {
      throw new Error(`Not a .tar.gz archive: ${input}`);
    }
    return { kind: "tarball", path: input };
  }
  const match = GITHUB_TARGET.exec(input);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(
      `Expected owner/repo[@ref], a directory or a .tar.gz file, got: ${input}`,
    );
  }
  return {
    kind: "github",
    owner: match[1],
    ref: match[3] ?? null,
    repo: match[2],
  };
}

async function readDirectoryArchive(root: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const children = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  for (const child of children) {
    if (!child.isFile()) continue;
    const absolute = join(child.parentPath, child.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (path.split("/").some((part) => SKIPPED_DIRECTORIES.has(part))) continue;
    entries.push({ content: await readFile(absolute), path });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function githubHeaders(
  source: GitHubSource,
  accept: string,
): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "public-repository-scan",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(source.token === undefined
      ? {}
      : { Authorization: `Bearer ${source.token}` }),
  };
}

async function githubGet(
  source: GitHubSource,
  path: string,
  accept: string,
): Promise<Response> {
  const response = await source.fetch(`${source.apiUrl}${path}`, {
    headers: githubHeaders(source, accept),
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub GET ${path} failed with ${String(response.status)}`,
    );
  }
  return response;
}

async function fetchGitHubRepository(
  source: GitHubSource,
  target: { owner: string; repo: string; ref: string | null },
): Promise<FetchedRepository> {
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const shaResponse = await githubGet(
    source,
    `${repoPath}/commits/${encodeURIComponent(target.ref ?? "HEAD")}`,
    "application/vnd.github.sha",
  );
  const commitSha = (await shaResponse.text()).trim();
  const tarball = await githubGet(
    source,
    `${repoPath}/tarball/${commitSha}`,
    "application/vnd.github+json",
  );
  return {
    archive: await extractTarGzArchive(
      Buffer.from(await tarball.arrayBuffer()),
    ),
    commitSha,
    repository: `${target.owner}/${target.repo}`,
  };
}

async function fetchRepository(
  target: RepositoryTarget,
  source: GitHubSource,
): Promise<FetchedRepository> {
  if (target.kind === "github") return fetchGitHubRepository(source, target);
  const archive =
    target.kind === "directory"
      ? await readDirectoryArchive(target.path)
      : await extractTarGzArchive(await readFile(target.path));
  return { archive, commitSha: null, repository: target.path };
}

export {
  fetchGitHubRepository,
  fetchRepository,
  parseRepositoryTarget,
  readDirectoryArchive,
};
export type { FetchedRepository, GitHubSource, RepositoryTarget };
