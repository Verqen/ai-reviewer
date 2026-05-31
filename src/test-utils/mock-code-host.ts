import type { ICodeHost } from "~/domain/ports/code-host.port";
import type {
  DiffFile,
  FileTreeEntry,
  InlinePosition,
  MergeRequestInfo,
  Note,
  VersionInfo,
} from "~/domain/types/code-host.types";

interface MockCodeHostCalls {
  getDefaultBranch: Array<[number]>;
  getMergeRequestDiff: Array<[number, number]>;
  getMergeRequestInfo: Array<[number, number]>;
  getMergeRequestVersions: Array<[number, number]>;
  postInlineComment: Array<[number, number, string, InlinePosition]>;
  postNote: Array<[number, number, string]>;
  replyToDiscussion: Array<[number, number, string, string]>;
  unresolveDiscussion: Array<[number, number, string]>;
}

interface MockCodeHostOptions {
  defaultBranch?: string;
  diffs?: DiffFile[];
  discussionNotes?: Note[];
  mergeRequestInfo?: Partial<MergeRequestInfo>;
  versions?: VersionInfo;
}

function createMockCodeHost(options: MockCodeHostOptions = {}): ICodeHost & {
  calls: MockCodeHostCalls;
} {
  const calls: MockCodeHostCalls = {
    getDefaultBranch: [],
    getMergeRequestDiff: [],
    getMergeRequestInfo: [],
    getMergeRequestVersions: [],
    postInlineComment: [],
    postNote: [],
    replyToDiscussion: [],
    unresolveDiscussion: [],
  };

  const defaultMrInfo: MergeRequestInfo = {
    description: "",
    iid: 1,
    projectId: 1,
    sourceBranch: "feature",
    targetBranch: "main",
    title: "Test MR",
    ...options.mergeRequestInfo,
  };

  const defaultVersions: VersionInfo = {
    baseSha: "base-sha",
    headSha: "head-sha",
    startSha: "start-sha",
    ...options.versions,
  };

  return {
    approveMergeRequest(): Promise<void> {
      return Promise.resolve();
    },

    calls,

    getBranchHeadSha(): Promise<string> {
      return Promise.resolve("abc123def456");
    },

    getCommitRangeDiff(
      _projectId: number,
      _from: string,
      _to: string,
      _options?: { straight?: boolean | undefined },
    ): Promise<DiffFile[]> {
      return Promise.resolve([]);
    },

    getDefaultBranch(projectId: number): Promise<string> {
      calls.getDefaultBranch.push([projectId]);
      return Promise.resolve(options.defaultBranch ?? "main");
    },

    getDiscussionNotes(): Promise<Note[]> {
      return Promise.resolve(options.discussionNotes ?? []);
    },

    getFileContent(): Promise<string> {
      return Promise.resolve("");
    },

    getFileTree(): Promise<FileTreeEntry[]> {
      return Promise.resolve([]);
    },

    getMergeRequestDiff(projectId: number, mrIid: number): Promise<DiffFile[]> {
      calls.getMergeRequestDiff.push([projectId, mrIid]);
      return Promise.resolve(options.diffs ?? []);
    },

    getMergeRequestInfo(
      projectId: number,
      mrIid: number,
    ): Promise<MergeRequestInfo> {
      calls.getMergeRequestInfo.push([projectId, mrIid]);
      return Promise.resolve(defaultMrInfo);
    },

    getMergeRequestVersions(
      projectId: number,
      mrIid: number,
    ): Promise<VersionInfo> {
      calls.getMergeRequestVersions.push([projectId, mrIid]);
      return Promise.resolve(defaultVersions);
    },

    getRepositoryArchive(): Promise<Array<{ content: Buffer; path: string }>> {
      return Promise.resolve([]);
    },

    listOpenMergeRequests(): Promise<MergeRequestInfo[]> {
      return Promise.resolve([]);
    },

    postInlineComment(
      projectId: number,
      mrIid: number,
      body: string,
      position: InlinePosition,
    ): Promise<{ discussionId: string; noteId: string }> {
      calls.postInlineComment.push([projectId, mrIid, body, position]);
      return Promise.resolve({ discussionId: "disc-1", noteId: "note-1" });
    },

    postNote(
      projectId: number,
      mrIid: number,
      body: string,
    ): Promise<{ noteId: string }> {
      calls.postNote.push([projectId, mrIid, body]);
      return Promise.resolve({ noteId: "note-post-1" });
    },

    replyToDiscussion(
      projectId: number,
      mrIid: number,
      discussionId: string,
      body: string,
    ): Promise<{ noteId: string }> {
      calls.replyToDiscussion.push([projectId, mrIid, discussionId, body]);
      return Promise.resolve({ noteId: "note-reply-1" });
    },

    resolveDiscussion(): Promise<void> {
      return Promise.resolve();
    },

    unapprove(): Promise<void> {
      return Promise.resolve();
    },

    unresolveDiscussion(
      projectId: number,
      mrIid: number,
      discussionId: string,
    ): Promise<void> {
      calls.unresolveDiscussion.push([projectId, mrIid, discussionId]);
      return Promise.resolve();
    },
  };
}

export { createMockCodeHost };
export type { MockCodeHostCalls, MockCodeHostOptions };
