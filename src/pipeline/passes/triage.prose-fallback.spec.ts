import { describe, expect, it } from "vitest";

import { parseProseTriageResponse } from "./triage.prose-fallback";

describe("parseProseTriageResponse", () => {
  it("parses the markdown-prose format that minimax/mini emits in production", () => {
    const raw = [
      "Let me analyze each hunk to determine if it's trivial or needs-review:",
      "",
      "**Hunk 0: apps/example-app/src/modules/chat/chat-message.helpers.ts**",
      "- Changed `CHAT_MAX_MESSAGE_CONTENT_LENGTH_BACKEND` from 2000 to 200",
      "- This is a significant change to a constant value that controls message content length limits",
      "- This affects runtime behavior - messages can now only be 200 characters instead of 2000",
      "- This is NOT trivial - it changes a business logic constant that affects how users can use the chat",
      "",
      "**Hunk 1: apps/example-app/src/modules/offers/offers-admin.use-cases.ts**",
      `- Added try-catch around softDelete with a comment "ignore — offer may have been already removed"`,
      "- This is NOT trivial - silently swallowing errors changes failure semantics",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result).not.toBeNull();
    expect(result!.results).toEqual([
      { hunk_id: 0, verdict: "needs-review" },
      { hunk_id: 1, verdict: "needs-review" },
    ]);
  });

  it("classifies hunks marked 'is trivial' as trivial", () => {
    const raw = [
      "**Hunk 0: src/utils/whitespace.ts**",
      "- Pure formatting change",
      "- This is trivial — no behavior change",
      "",
      "**Hunk 1: src/modules/auth/login.ts**",
      "- Added new branch for password reset",
      "- This is NOT trivial",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result).not.toBeNull();
    expect(result!.results).toEqual([
      { hunk_id: 0, verdict: "trivial" },
      { hunk_id: 1, verdict: "needs-review" },
    ]);
  });

  it("returns null when no markdown hunk headers are present", () => {
    const raw = "Some unrelated narrative without hunk markers at all.";
    expect(parseProseTriageResponse(raw)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseProseTriageResponse("")).toBeNull();
  });

  it("defaults to needs-review when verdict signal is ambiguous (defensive)", () => {
    const raw = [
      "**Hunk 7: src/some/file.ts**",
      "- Some change with no explicit trivial/non-trivial wording.",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result).not.toBeNull();
    expect(result!.results).toEqual([{ hunk_id: 7, verdict: "needs-review" }]);
  });

  it("deduplicates repeated hunk headers, keeping the first occurrence", () => {
    const raw = [
      "**Hunk 3: src/a.ts**",
      "- This is trivial",
      "",
      "**Hunk 3: src/a.ts**",
      "- This is NOT trivial",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result!.results).toEqual([{ hunk_id: 3, verdict: "trivial" }]);
  });

  it("ignores headers without a numeric hunk id", () => {
    const raw = [
      "**Hunk: not-a-number**",
      "- This is trivial",
      "",
      "**Hunk 4: src/b.ts**",
      "- This is NOT trivial",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result!.results).toEqual([{ hunk_id: 4, verdict: "needs-review" }]);
  });

  it("parses plain 'Hunk N:' headers without ** markdown bold", () => {
    const raw = [
      "Let me analyze each hunk to classify them as trivial or needs-review.",
      "",
      "Hunk 0: `.agents/REVIEW.md`",
      "This adds documentation/rules about logging. Purely documentation. This is trivial.",
      "",
      "Hunk 1: `apps/example-app/src/scripts/migrate-backfill.ts`",
      "This adds runtime error handling and logging infrastructure. This is needs-review.",
    ].join("\n");

    const result = parseProseTriageResponse(raw);

    expect(result).not.toBeNull();
    expect(result!.results).toEqual([
      { hunk_id: 0, verdict: "trivial" },
      { hunk_id: 1, verdict: "needs-review" },
    ]);
  });

  it("classifies a single-hunk batch with no header when expectedHunkIds=[id]", () => {
    const raw = [
      "Let me analyze this hunk:",
      "",
      "The change in apps/example-app/src/utils/cookies.ts modifies COOKIE_OPTIONS_BASE.",
      "It changes httpOnly: true to httpOnly: false.",
      "This is a security-sensitive change weakening XSS protection.",
      `It should be classified as "needs-review" because it changes a security-related cookie flag.`,
    ].join("\n");

    const result = parseProseTriageResponse(raw, { expectedHunkIds: [0] });

    expect(result).not.toBeNull();
    expect(result!.results).toEqual([{ hunk_id: 0, verdict: "needs-review" }]);
  });

  it("classifies a trivial single-hunk batch with no header", () => {
    const raw =
      "This hunk only fixes a typo in a comment. It is trivial — no behavior change.";

    const result = parseProseTriageResponse(raw, { expectedHunkIds: [42] });

    expect(result!.results).toEqual([{ hunk_id: 42, verdict: "trivial" }]);
  });

  it("returns null for multi-hunk batches without headers (cannot disambiguate)", () => {
    const raw =
      "Some prose without any hunk headers describing two unrelated changes mixed together.";

    expect(
      parseProseTriageResponse(raw, { expectedHunkIds: [0, 1] })
    ).toBeNull();
  });
});
