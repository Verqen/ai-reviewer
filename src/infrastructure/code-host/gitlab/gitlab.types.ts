interface GitLabMrApiResponse {
  description: string;
  iid: number;
  project_id: number;
  source_branch: string;
  target_branch: string;
  title: string;
}

interface GitLabDiffChange {
  diff: string;
  new_path: string;
  old_path: string;
}

interface GitLabMrChangesResponse {
  changes: GitLabDiffChange[];
  changes_count?: string;
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  overflow?: boolean;
}

interface GitLabVersionApiEntry {
  base_commit_sha: string;
  head_commit_sha: string;
  start_commit_sha: string;
}

interface GitLabDiscussionApiResponse {
  notes: Array<{
    author: { username: string };
    body: string;
  }>;
}

interface GitLabDiscussionCreatedResponse {
  id: string;
  notes: Array<{ id: string }>;
}

interface GitLabNoteCreatedResponse {
  id: string;
}

interface GitLabBranchApiResponse {
  commit: { id: string };
}

interface GitLabProjectApiResponse {
  default_branch: string;
}

interface GitLabFileTreeEntry {
  path: string;
  type: "blob" | "tree";
}

interface GitLabCompareResponse {
  diffs: GitLabDiffChange[];
}

export type {
  GitLabBranchApiResponse,
  GitLabCompareResponse,
  GitLabDiffChange,
  GitLabDiscussionApiResponse,
  GitLabDiscussionCreatedResponse,
  GitLabFileTreeEntry,
  GitLabMrApiResponse,
  GitLabMrChangesResponse,
  GitLabNoteCreatedResponse,
  GitLabProjectApiResponse,
  GitLabVersionApiEntry,
};
