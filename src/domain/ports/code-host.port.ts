import type {
  ArchiveEntry,
  DiffFile,
  FileTreeEntry,
  InlinePosition,
  MergeRequestInfo,
  Note,
  VersionInfo,
} from "~/domain/types/code-host.types";

type CommitRangeDiffOptions = {
  straight?: boolean | undefined;
};

interface ICodeHost {
  approveMergeRequest(projectId: number, mrIid: number): Promise<void>;

  getBranchHeadSha(projectId: number, branch: string): Promise<string>;

  getCommitRangeDiff(
    projectId: number,
    from: string,
    to: string,
    options?: CommitRangeDiffOptions
  ): Promise<DiffFile[]>;

  getDefaultBranch(projectId: number): Promise<string>;

  getDiscussionNotes(
    projectId: number,
    mrIid: number,
    discussionId: string
  ): Promise<Note[]>;

  getFileContent(projectId: number, ref: string, path: string): Promise<string>;

  getFileTree(projectId: number, ref: string): Promise<FileTreeEntry[]>;

  getMergeRequestDiff(projectId: number, mrIid: number): Promise<DiffFile[]>;

  getMergeRequestInfo(
    projectId: number,
    mrIid: number
  ): Promise<MergeRequestInfo>;

  getMergeRequestVersions(
    projectId: number,
    mrIid: number
  ): Promise<VersionInfo>;

  getRepositoryArchive(projectId: number, ref: string): Promise<ArchiveEntry[]>;

  listOpenMergeRequests(
    projectId: number,
    targetBranch: string
  ): Promise<MergeRequestInfo[]>;

  postInlineComment(
    projectId: number,
    mrIid: number,
    body: string,
    position: InlinePosition
  ): Promise<{ discussionId: string; noteId: string }>;

  postNote(
    projectId: number,
    mrIid: number,
    body: string
  ): Promise<{ noteId: string }>;

  replyToDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    body: string
  ): Promise<{ noteId: string }>;

  resolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string
  ): Promise<void>;

  unapprove(projectId: number, mrIid: number): Promise<void>;

  unresolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string
  ): Promise<void>;
}

export type { CommitRangeDiffOptions, ICodeHost };
