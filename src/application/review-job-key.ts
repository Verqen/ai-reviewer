export function buildCanonicalMrReviewJobKey(
  projectId: number,
  mrIid: number,
): string {
  return `full_review:${projectId}:${mrIid}`;
}

export function buildThreadResponseJobKey(
  projectId: number,
  mrIid: number,
  discussionId: string,
): string {
  return `thread_response:${projectId}:${mrIid}:${discussionId}`;
}

export function buildCommentResponseJobKey(
  projectId: number,
  mrIid: number,
  discussionId: string | null | undefined,
): string {
  return `comment_response:${projectId}:${mrIid}:${discussionId ?? "general"}`;
}

export function buildBootstrapBaselineJobKey(projectId: number): string {
  return `bootstrap_baseline:${projectId}`;
}

export function buildUpdateBaselineJobKey(projectId: number): string {
  return `update_baseline:${projectId}`;
}

export function buildMainPushReReviewJobKey(projectId: number): string {
  return `main_push_re_review:${projectId}`;
}
