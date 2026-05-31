export function buildCanonicalMrReviewJobKey(
  projectId: number,
  mrIid: number,
): string {
  return `full_review:${projectId}:${mrIid}`;
}
