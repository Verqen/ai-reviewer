import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";
import { extract as tarExtract } from "tar-stream";
import { z } from "zod";

import type { GitHubConfigSchema } from "~/config/github.config";
import type {
  CommitRangeDiffOptions,
  ICodeHost,
} from "~/domain/ports/code-host.port";
import type {
  ArchiveEntry,
  DiffFile,
  FileTreeEntry,
  InlinePosition,
  MergeRequestInfo,
  Note,
  VersionInfo,
} from "~/domain/types/code-host.types";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";

const GitHubNotFoundError = CodeHostNotFoundError;

/**
 * GitHub exposes repositories by `owner/repo`, but the review pipeline keys
 * everything by the numeric repository id (carried in `projectId`). The legacy
 * `GET /repositories/{id}` endpoint resolves the id back to its coordinates.
 */
const RepoCoordinatesSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

const ReviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        nodes: z.array(
          z.object({
            comments: z.object({
              nodes: z.array(z.object({ databaseId: z.number().nullable() })),
            }),
            id: z.string(),
          }),
        ),
      }),
    }),
  }),
});

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

function createGitHubOctokit(config: IConfig<GitHubConfigSchema>): Octokit {
  const { GITHUB_API_URL, GITHUB_TOKEN } = config.envs;
  if (GITHUB_TOKEN) {
    return new Octokit({ auth: GITHUB_TOKEN, baseUrl: GITHUB_API_URL });
  }
  const keyPath = config.envs.GITHUB_APP_PRIVATE_KEY_PATH;
  const privateKey =
    config.envs.GITHUB_APP_PRIVATE_KEY ??
    (keyPath !== undefined ? readFileSync(keyPath, "utf8") : undefined);
  if (privateKey === undefined) {
    throw new Error("GitHub App private key is not configured");
  }
  return new Octokit({
    auth: {
      appId: config.envs.GITHUB_APP_ID,
      installationId: config.envs.GITHUB_APP_INSTALLATION_ID,
      privateKey,
    },
    authStrategy: createAppAuth,
    baseUrl: GITHUB_API_URL,
  });
}

class GitHubCodeHost implements ICodeHost {
  private readonly botUsername: string;
  private readonly repoCache = new Map<
    number,
    { owner: string; repo: string }
  >();

  constructor(
    private readonly octokit: Octokit,
    config: IConfig<GitHubConfigSchema>,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.botUsername = config.envs.GITHUB_BOT_USERNAME;
  }

  private async resolveRepo(
    projectId: number,
  ): Promise<{ owner: string; repo: string }> {
    const cached = this.repoCache.get(projectId);
    if (cached) {
      return cached;
    }
    try {
      const response = await this.octokit.request(
        "GET /repositories/{repository_id}",
        { repository_id: projectId },
      );
      const parsed = RepoCoordinatesSchema.parse(response.data);
      const coordinates = { owner: parsed.owner.login, repo: parsed.name };
      this.repoCache.set(projectId, coordinates);
      return coordinates;
    } catch (error) {
      if (isNotFound(error)) {
        throw new GitHubNotFoundError(`Repository not found: id=${projectId}`);
      }
      throw error;
    }
  }

  async getBranchHeadSha(projectId: number, branch: string): Promise<string> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.repos.getBranch({
      branch,
      owner,
      repo,
    });
    return response.data.commit.sha;
  }

  async getDefaultBranch(projectId: number): Promise<string> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.repos.get({ owner, repo });
    return response.data.default_branch;
  }

  async getMergeRequestInfo(
    projectId: number,
    mrIid: number,
  ): Promise<MergeRequestInfo> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.pulls.get({
      owner,
      pull_number: mrIid,
      repo,
    });
    return {
      description: response.data.body ?? "",
      iid: response.data.number,
      projectId,
      sourceBranch: response.data.head.ref,
      targetBranch: response.data.base.ref,
      title: response.data.title,
    };
  }

  async getMergeRequestDiff(
    projectId: number,
    mrIid: number,
  ): Promise<DiffFile[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const files = await this.octokit.paginate(
      this.octokit.rest.pulls.listFiles,
      { owner, per_page: 100, pull_number: mrIid, repo },
    );
    return files.map((file) => ({
      diff: file.patch ?? "",
      newPath: file.filename,
      oldPath: file.previous_filename ?? file.filename,
    }));
  }

  async getMergeRequestVersions(
    projectId: number,
    mrIid: number,
  ): Promise<VersionInfo> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.pulls.get({
      owner,
      pull_number: mrIid,
      repo,
    });
    return {
      baseSha: response.data.base.sha,
      headSha: response.data.head.sha,
      startSha: response.data.base.sha,
    };
  }

  async getCommitRangeDiff(
    projectId: number,
    from: string,
    to: string,
    _options?: CommitRangeDiffOptions,
  ): Promise<DiffFile[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.repos.compareCommitsWithBasehead({
      basehead: `${from}...${to}`,
      owner,
      repo,
    });
    const files = response.data.files ?? [];
    return files.map((file) => ({
      diff: file.patch ?? "",
      newPath: file.filename,
      oldPath: file.previous_filename ?? file.filename,
    }));
  }

  async listOpenMergeRequests(
    projectId: number,
    targetBranch: string,
  ): Promise<MergeRequestInfo[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const pulls = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      base: targetBranch,
      owner,
      per_page: 100,
      repo,
      state: "open",
    });
    return pulls.map((pull) => ({
      description: pull.body ?? "",
      iid: pull.number,
      projectId,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      title: pull.title,
    }));
  }

  async getFileContent(
    projectId: number,
    ref: string,
    path: string,
  ): Promise<string> {
    const { owner, repo } = await this.resolveRepo(projectId);
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          headers: { accept: "application/vnd.github.raw" },
          owner,
          path,
          ref,
          repo,
        },
      );
      if (typeof response.data === "string") {
        return response.data;
      }
      throw new Error(`Unexpected non-raw content response for ${path}`);
    } catch (error) {
      if (isNotFound(error)) {
        throw new GitHubNotFoundError(`File not found: ${path}`);
      }
      throw error;
    }
  }

  async getFileTree(projectId: number, ref: string): Promise<FileTreeEntry[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.git.getTree({
      owner,
      recursive: "true",
      repo,
      tree_sha: ref,
    });
    if (response.data.truncated) {
      this.logger.warn(
        { projectId, ref },
        "GitHub getFileTree result truncated by the API",
      );
    }
    return response.data.tree
      .filter((entry) => entry.type === "blob" && entry.path !== undefined)
      .map((entry) => ({ path: entry.path ?? "", type: "blob" as const }));
  }

  async getDiscussionNotes(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<Note[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const rootId = Number(discussionId);
    const comments = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviewComments,
      { owner, per_page: 100, pull_number: mrIid, repo },
    );
    return comments
      .filter(
        (comment) => comment.id === rootId || comment.in_reply_to_id === rootId,
      )
      .map((comment) => ({
        author: comment.user.login,
        body: comment.body,
      }));
  }

  async postInlineComment(
    projectId: number,
    mrIid: number,
    body: string,
    position: InlinePosition,
  ): Promise<{ discussionId: string; noteId: string }> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const onNewSide = position.newLine !== undefined;
    const line = onNewSide ? position.newLine : position.oldLine;
    if (line === undefined) {
      throw new Error("InlinePosition has neither newLine nor oldLine");
    }
    const response = await this.octokit.rest.pulls.createReviewComment({
      body,
      commit_id: position.headSha,
      line,
      owner,
      path: onNewSide ? position.newPath : position.oldPath,
      pull_number: mrIid,
      repo,
      side: onNewSide ? "RIGHT" : "LEFT",
    });
    const id = String(response.data.id);
    return { discussionId: id, noteId: id };
  }

  async replyToDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<{ noteId: string }> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.pulls.createReplyForReviewComment({
      body,
      comment_id: Number(discussionId),
      owner,
      pull_number: mrIid,
      repo,
    });
    return { noteId: String(response.data.id) };
  }

  async postNote(
    projectId: number,
    mrIid: number,
    body: string,
  ): Promise<{ noteId: string }> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const response = await this.octokit.rest.issues.createComment({
      body,
      issue_number: mrIid,
      owner,
      repo,
    });
    return { noteId: String(response.data.id) };
  }

  async resolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<void> {
    const threadId = await this.findThreadNodeId(
      projectId,
      mrIid,
      discussionId,
    );
    if (!threadId) {
      return;
    }
    await this.octokit.graphql(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId },
    );
  }

  async unresolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<void> {
    const threadId = await this.findThreadNodeId(
      projectId,
      mrIid,
      discussionId,
    );
    if (!threadId) {
      return;
    }
    await this.octokit.graphql(
      `mutation($threadId: ID!) {
        unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId },
    );
  }

  async approveMergeRequest(projectId: number, mrIid: number): Promise<void> {
    const { owner, repo } = await this.resolveRepo(projectId);
    await this.octokit.rest.pulls.createReview({
      event: "APPROVE",
      owner,
      pull_number: mrIid,
      repo,
    });
  }

  async unapprove(projectId: number, mrIid: number): Promise<void> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const reviews = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviews,
      { owner, per_page: 100, pull_number: mrIid, repo },
    );
    const ownApproval = reviews
      .reverse()
      .find(
        (review) =>
          review.state === "APPROVED" &&
          review.user?.login === this.botUsername,
      );
    if (!ownApproval) {
      return;
    }
    await this.octokit.rest.pulls.dismissReview({
      message: "Superseded by a new review run.",
      owner,
      pull_number: mrIid,
      repo,
      review_id: ownApproval.id,
    });
  }

  async getRepositoryArchive(
    projectId: number,
    ref: string,
  ): Promise<ArchiveEntry[]> {
    const { owner, repo } = await this.resolveRepo(projectId);
    this.logger.info({ owner, ref, repo }, "Fetching repository archive");

    const response = await this.octokit.rest.repos.downloadTarballArchive({
      owner,
      ref,
      repo,
    });
    // Octokit types the tarball body as `unknown`; the REST endpoint returns the
    // raw archive bytes, so we narrow to ArrayBuffer to wrap it in a Buffer.
    const archive = Buffer.from(response.data as ArrayBuffer);

    const entries: ArchiveEntry[] = [];
    const gunzip = createGunzip();
    const tar = tarExtract();

    await new Promise<void>((resolve, reject) => {
      tar.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          if (header.type === "file" && header.name) {
            const filePath = header.name.split("/").slice(1).join("/");
            if (filePath) {
              entries.push({ content: Buffer.concat(chunks), path: filePath });
            }
          }
          next();
        });
        stream.resume();
      });
      tar.on("finish", resolve);
      tar.on("error", reject);
      gunzip.on("error", reject);
      Readable.from(archive).pipe(gunzip).pipe(tar);
    });

    this.logger.info(
      { fileCount: entries.length, owner, ref, repo },
      "Repository archive extracted",
    );
    return entries;
  }

  private async findThreadNodeId(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<string | null> {
    const { owner, repo } = await this.resolveRepo(projectId);
    const rootId = Number(discussionId);
    const result = await this.octokit.graphql<unknown>(
      `query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes { id comments(first: 1) { nodes { databaseId } } }
            }
          }
        }
      }`,
      { owner, pr: mrIid, repo },
    );
    const parsed = ReviewThreadsSchema.parse(result);
    const thread = parsed.repository.pullRequest.reviewThreads.nodes.find(
      (node) => node.comments.nodes[0]?.databaseId === rootId,
    );
    return thread?.id ?? null;
  }
}

export { createGitHubOctokit, GitHubCodeHost, GitHubNotFoundError };
