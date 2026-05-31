import { get as httpsGet } from "node:https";
import { createGunzip } from "node:zlib";

import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";
import { extract as tarExtract } from "tar-stream";

import type { GitLabConfigSchema } from "~/config/gitlab.config";
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
import type {
  GitLabBranchApiResponse,
  GitLabCompareResponse,
  GitLabDiscussionApiResponse,
  GitLabDiscussionCreatedResponse,
  GitLabFileTreeEntry,
  GitLabMrApiResponse,
  GitLabMrChangesResponse,
  GitLabNoteCreatedResponse,
  GitLabProjectApiResponse,
  GitLabVersionApiEntry,
} from "~/infrastructure/code-host/gitlab/gitlab.types";

const GitLabNotFoundError = CodeHostNotFoundError;
const MAX_PAGES = 50;

class GitLabCodeHost implements ICodeHost {
  private readonly apiUrl: string;
  private readonly token: string;

  constructor(
    config: IConfig<GitLabConfigSchema>,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.apiUrl = config.envs.GITLAB_API_URL;
    this.token = config.envs.GITLAB_TOKEN;
  }

  async getBranchHeadSha(projectId: number, branch: string): Promise<string> {
    const response = await this.request<GitLabBranchApiResponse>(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
    );

    return response.commit.id;
  }

  async getDefaultBranch(projectId: number): Promise<string> {
    const response = await this.request<GitLabProjectApiResponse>(
      `/projects/${projectId}`,
    );

    return response.default_branch;
  }

  async getMergeRequestInfo(
    projectId: number,
    mrIid: number,
  ): Promise<MergeRequestInfo> {
    const response = await this.request<GitLabMrApiResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}`,
    );

    return {
      description: response.description,
      iid: response.iid,
      projectId: response.project_id,
      sourceBranch: response.source_branch,
      targetBranch: response.target_branch,
      title: response.title,
    };
  }

  /**
   * Fetch the MR diff via the legacy `/changes` endpoint, with an automatic
   * fallback to `/repository/compare` when GitLab signals overflow.
   *
   * The legacy endpoint silently truncates large MRs (~200 files / 200K lines,
   * limit configured per GitLab instance) and reports it via `overflow: true`.
   * The compare endpoint is unbounded but requires explicit base/head SHAs,
   * which we extract from the same response (`diff_refs`).
   */
  async getMergeRequestDiff(
    projectId: number,
    mrIid: number,
  ): Promise<DiffFile[]> {
    const response = await this.request<GitLabMrChangesResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}/changes`,
    );

    const returnedCount = response.changes.length;
    const reportedCount = response.changes_count
      ? Number(response.changes_count)
      : undefined;
    const isTruncated =
      response.overflow === true ||
      (reportedCount !== undefined &&
        Number.isFinite(reportedCount) &&
        reportedCount > returnedCount);

    if (!isTruncated) {
      return response.changes.map((change) => ({
        diff: change.diff,
        newPath: change.new_path,
        oldPath: change.old_path,
      }));
    }

    const baseSha = response.diff_refs?.base_sha;
    const headSha = response.diff_refs?.head_sha;
    if (!baseSha || !headSha) {
      this.logger.warn(
        {
          mrIid,
          overflow: response.overflow,
          projectId,
          reportedCount,
          returnedCount,
        },
        "GitLab /changes truncated MR diff but diff_refs missing — returning truncated set",
      );
      return response.changes.map((change) => ({
        diff: change.diff,
        newPath: change.new_path,
        oldPath: change.old_path,
      }));
    }

    this.logger.warn(
      {
        baseSha,
        headSha,
        mrIid,
        overflow: response.overflow,
        projectId,
        reportedCount,
        returnedCount,
      },
      "GitLab /changes truncated MR diff — falling back to /repository/compare",
    );

    const fallback = await this.getCommitRangeDiff(projectId, baseSha, headSha);
    this.logger.info(
      {
        compareCount: fallback.length,
        mrIid,
        projectId,
        recoveredCount: fallback.length - returnedCount,
        truncatedCount: returnedCount,
      },
      "GitLab MR diff recovered via /repository/compare",
    );
    return fallback;
  }

  async getMergeRequestVersions(
    projectId: number,
    mrIid: number,
  ): Promise<VersionInfo> {
    const versions = await this.request<GitLabVersionApiEntry[]>(
      `/projects/${projectId}/merge_requests/${mrIid}/versions`,
    );

    const latest = versions[0];

    if (!latest) {
      throw new Error(`No versions found for MR !${mrIid}`);
    }

    return {
      baseSha: latest.base_commit_sha,
      headSha: latest.head_commit_sha,
      startSha: latest.start_commit_sha,
    };
  }

  async getCommitRangeDiff(
    projectId: number,
    from: string,
    to: string,
    options?: CommitRangeDiffOptions,
  ): Promise<DiffFile[]> {
    const straightClause = options?.straight === true ? "&straight=true" : "";
    const response = await this.request<GitLabCompareResponse>(
      `/projects/${projectId}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${straightClause}`,
    );

    return response.diffs.map((change) => ({
      diff: change.diff,
      newPath: change.new_path,
      oldPath: change.old_path,
    }));
  }

  async listOpenMergeRequests(
    projectId: number,
    targetBranch: string,
  ): Promise<MergeRequestInfo[]> {
    const allMrs: MergeRequestInfo[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const path = `/projects/${projectId}/merge_requests?state=opened&target_branch=${encodeURIComponent(targetBranch)}&per_page=100&page=${page}`;
      const batch = await this.request<GitLabMrApiResponse[]>(path);

      if (batch.length === 0) {
        break;
      }

      for (const mr of batch) {
        allMrs.push({
          description: mr.description,
          iid: mr.iid,
          projectId: mr.project_id,
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
          title: mr.title,
        });
      }

      if (batch.length < 100) {
        break;
      }

      if (page === MAX_PAGES) {
        this.logger.warn(
          { projectId, targetBranch },
          "listOpenMergeRequests reached MAX_PAGES limit",
        );
        break;
      }

      page++;
    }

    return allMrs;
  }

  async getFileContent(
    projectId: number,
    ref: string,
    path: string,
  ): Promise<string> {
    const url = `${this.apiUrl}/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;

    this.logger.debug({ path, projectId, ref }, "GitLab API getFileContent");

    const response = await fetch(url, {
      headers: {
        "PRIVATE-TOKEN": this.token,
      },
    });

    if (response.status === 404) {
      throw new GitLabNotFoundError(`File not found: ${path}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitLab API error: ${response.status} ${errorText}`);
    }

    return response.text();
  }

  async getFileTree(projectId: number, ref: string): Promise<FileTreeEntry[]> {
    const allEntries: FileTreeEntry[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const path = `/projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`;
      const batch = await this.request<GitLabFileTreeEntry[]>(path);

      if (batch.length === 0) {
        break;
      }

      for (const e of batch) {
        if (e.type === "blob") {
          allEntries.push({ path: e.path, type: e.type });
        }
      }

      if (batch.length < 100) {
        break;
      }

      if (page === MAX_PAGES) {
        this.logger.warn(
          { projectId, ref },
          "getFileTree reached MAX_PAGES limit",
        );
        break;
      }

      page++;
    }

    return allEntries;
  }

  async getDiscussionNotes(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<Note[]> {
    const discussion = await this.request<GitLabDiscussionApiResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
    );

    return discussion.notes.map((note) => ({
      author: note.author.username,
      body: note.body,
    }));
  }

  async postInlineComment(
    projectId: number,
    mrIid: number,
    body: string,
    position: InlinePosition,
  ): Promise<{ discussionId: string; noteId: string }> {
    const positionPayload: Record<string, number | string> = {
      base_sha: position.baseSha,
      head_sha: position.headSha,
      new_path: position.newPath,
      old_path: position.oldPath,
      position_type: position.positionType,
      start_sha: position.startSha,
    };

    if (position.newLine !== undefined) {
      positionPayload["new_line"] = position.newLine;
    }

    if (position.oldLine !== undefined) {
      positionPayload["old_line"] = position.oldLine;
    }

    const response = await this.request<GitLabDiscussionCreatedResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      {
        body: JSON.stringify({ body, position: positionPayload }),
        method: "POST",
      },
    );

    const noteId = response.notes[0]?.id;

    if (!noteId) {
      throw new Error("No note ID in discussion creation response");
    }

    return { discussionId: response.id, noteId };
  }

  async replyToDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<{ noteId: string }> {
    const response = await this.request<GitLabNoteCreatedResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      {
        body: JSON.stringify({ body }),
        method: "POST",
      },
    );

    return { noteId: response.id };
  }

  async postNote(
    projectId: number,
    mrIid: number,
    body: string,
  ): Promise<{ noteId: string }> {
    const response = await this.request<GitLabNoteCreatedResponse>(
      `/projects/${projectId}/merge_requests/${mrIid}/notes`,
      {
        body: JSON.stringify({ body }),
        method: "POST",
      },
    );

    return { noteId: response.id };
  }

  async resolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<void> {
    await this.request(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      {
        body: JSON.stringify({ resolved: true }),
        method: "PUT",
      },
    );
  }

  async unresolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
  ): Promise<void> {
    await this.request(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      {
        body: JSON.stringify({ resolved: false }),
        method: "PUT",
      },
    );
  }

  async approveMergeRequest(projectId: number, mrIid: number): Promise<void> {
    await this.request(
      `/projects/${projectId}/merge_requests/${mrIid}/approve`,
      { method: "POST" },
    );
  }

  async unapprove(projectId: number, mrIid: number): Promise<void> {
    await this.request(
      `/projects/${projectId}/merge_requests/${mrIid}/unapprove`,
      { method: "POST" },
    );
  }

  async getRepositoryArchive(
    projectId: number,
    ref: string,
  ): Promise<ArchiveEntry[]> {
    const url = `${this.apiUrl}/projects/${projectId}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;

    this.logger.info({ projectId, ref }, "Fetching repository archive");

    const entries: ArchiveEntry[] = [];
    const gunzip = createGunzip();
    const tar = tarExtract();

    await new Promise<void>((resolve, reject) => {
      tar.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];

        stream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        stream.on("end", () => {
          if (header.type === "file" && header.name) {
            const pathParts = header.name.split("/");
            const filePath = pathParts.slice(1).join("/");

            if (filePath) {
              entries.push({
                content: Buffer.concat(chunks),
                path: filePath,
              });
            }
          }

          next();
        });

        stream.resume();
      });

      tar.on("finish", resolve);
      tar.on("error", reject);
      gunzip.on("error", reject);
      gunzip.pipe(tar);

      httpsGet(url, { headers: { "PRIVATE-TOKEN": this.token } }, (res) => {
        if (res.statusCode === 404) {
          reject(
            new GitLabNotFoundError(
              `Repository archive not found: project=${projectId} ref=${ref}`,
            ),
          );
          res.resume();
          return;
        }

        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            reject(
              new Error(
                `GitLab API error: ${res.statusCode} ${Buffer.concat(chunks).toString()}`,
              ),
            );
          });
          return;
        }

        res.pipe(gunzip);
      }).on("error", reject);
    });

    this.logger.info(
      { fileCount: entries.length, projectId, ref },
      "Repository archive extracted",
    );

    return entries;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.apiUrl}${path}`;

    this.logger.debug(
      { method: init?.method ?? "GET", url },
      "GitLab API request",
    );

    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": this.token,
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new GitLabNotFoundError(`GitLab API 404: ${path} ${errorText}`);
      }
      throw new Error(`GitLab API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }
}

export { GitLabCodeHost, GitLabNotFoundError };
