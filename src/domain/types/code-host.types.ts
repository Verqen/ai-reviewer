class CodeHostNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeHostNotFoundError";
  }
}

interface MergeRequestInfo {
  description: string;
  iid: number;
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
}

interface DiffFile {
  diff: string;
  newPath: string;
  oldPath: string;
}

interface VersionInfo {
  baseSha: string;
  headSha: string;
  startSha: string;
}

interface Note {
  author: string;
  body: string;
}

interface InlinePosition {
  baseSha: string;
  headSha: string;
  newLine?: number | undefined;
  newPath: string;
  oldLine?: number | undefined;
  oldPath: string;
  positionType: "text";
  startSha: string;
}

interface FileTreeEntry {
  path: string;
  type: "blob" | "tree";
}

type WebhookEvent =
  | { type: "mr_open"; projectId: number; mrIid: number; headSha: string }
  | { type: "mr_undraft"; projectId: number; mrIid: number; headSha: string }
  | {
      type: "mr_update";
      projectId: number;
      mrIid: number;
      headSha: string;
      previousHeadSha?: string | undefined;
    }
  | {
      type: "note";
      projectId: number;
      mrIid: number;
      note: string;
      authorUsername: string;
      discussionId?: string | undefined;
      position?:
        | {
            newPath?: string | undefined;
            newLine?: number | undefined;
            oldPath?: string | undefined;
            oldLine?: number | undefined;
          }
        | undefined;
    }
  | {
      type: "push";
      projectId: number;
      ref: string;
      beforeSha: string;
      afterSha: string;
      commits: Array<{
        added: string[];
        modified: string[];
        removed: string[];
      }>;
    };

export { CodeHostNotFoundError };

interface ArchiveEntry {
  content: Buffer;
  path: string;
}

export type {
  ArchiveEntry,
  DiffFile,
  FileTreeEntry,
  InlinePosition,
  MergeRequestInfo,
  Note,
  VersionInfo,
  WebhookEvent,
};
