import type { PackageRootsInsight } from "~/domain/types/package-roots.types";

interface ContentMatch {
  filePath: string;
  matches: string[];
}
interface BaselineState {
  commitSha: string;
  errorMessage: string | null;
  status: "missing" | "bootstrapping" | "ready" | "failed";
}

interface ISnapshotRepository {
  copySnapshotEntries(
    projectId: number,
    fromSha: string,
    toSha: string,
    excludePaths?: Set<string>
  ): Promise<number>;

  deleteCommit(projectId: number, commitSha: string): Promise<void>;

  deleteOldSnapshotsBefore(now: Date): Promise<number>;

  getBaselineState(projectId: number): Promise<BaselineState | null>;

  getFileContent(
    projectId: number,
    commitSha: string,
    filePath: string
  ): Promise<string | null>;

  listFiles(
    projectId: number,
    commitSha: string,
    pattern?: string
  ): Promise<string[]>;

  listPackageRootsFromSnapshot(
    projectId: number,
    commitSha: string
  ): Promise<PackageRootsInsight>;

  searchContent(
    projectId: number,
    commitSha: string,
    pattern: string,
    glob?: string
  ): Promise<ContentMatch[]>;

  setBaselineState(
    projectId: number,
    commitSha: string,
    status: BaselineState["status"],
    errorMessage?: string
  ): Promise<void>;

  storeBlobs(blobs: Array<{ hash: string; content: Buffer }>): Promise<void>;

  storeSnapshot(params: {
    commitSha: string;
    entries: Array<{ blobHash: string; filePath: string }>;
    projectId: number;
  }): Promise<void>;
}

export type {
  BaselineState,
  ContentMatch,
  ISnapshotRepository,
  PackageRootsInsight,
};
