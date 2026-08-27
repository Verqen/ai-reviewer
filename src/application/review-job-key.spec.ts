import { describe, expect, it } from "vitest";

import {
  buildBootstrapBaselineJobKey,
  buildCanonicalMrReviewJobKey,
  buildCommentResponseJobKey,
  buildThreadResponseJobKey,
  buildUpdateBaselineJobKey,
} from "~/application/review-job-key";

describe("review job keys", () => {
  it("namespaces the canonical merge request review key", () => {
    expect(buildCanonicalMrReviewJobKey(42, 7)).toBe("full_review:42:7");
  });

  it("namespaces the thread response key by discussion", () => {
    expect(buildThreadResponseJobKey(42, 7, "disc-1")).toBe(
      "thread_response:42:7:disc-1",
    );
  });

  it("namespaces the comment response key by discussion", () => {
    expect(buildCommentResponseJobKey(42, 7, "disc-abc")).toBe(
      "comment_response:42:7:disc-abc",
    );
  });

  it("falls back to a general comment response key without a discussion", () => {
    expect(buildCommentResponseJobKey(42, 7, undefined)).toBe(
      "comment_response:42:7:general",
    );
    expect(buildCommentResponseJobKey(42, 7, null)).toBe(
      "comment_response:42:7:general",
    );
  });

  it("namespaces baseline keys by project", () => {
    expect(buildBootstrapBaselineJobKey(42)).toBe("bootstrap_baseline:42");
    expect(buildUpdateBaselineJobKey(42)).toBe("update_baseline:42");
  });
});
