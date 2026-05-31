import { describe, expect, it } from "vitest";

import { formatCommentWithSuggestion } from "./suggestion-formatter";

describe("formatCommentWithSuggestion", () => {
  it("returns plain header when no suggestion provided", () => {
    const result = formatCommentWithSuggestion("Use const here", "warning");
    expect(result).toBe("[WARNING] Use const here");
  });

  it("uppercases severity in header", () => {
    const result = formatCommentWithSuggestion("Note this", "nitpick");
    expect(result).toContain("[NITPICK]");
  });

  it("returns plain header for lineType removed even with suggestion present", () => {
    const result = formatCommentWithSuggestion(
      "Old code removed",
      "info",
      "new replacement",
      "old code",
      "removed",
      10,
      undefined,
    );
    expect(result).toBe("[INFO] Old code removed");
    expect(result).not.toContain("```suggestion");
  });

  it("emits single-line suggestion block when endLineNumber is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Improve this",
      "warning",
      "const x = 1;",
      "var x = 1;",
      "added",
      5,
      undefined,
    );
    expect(result).toContain("```suggestion:-0+0");
    expect(result).toContain("const x = 1;");
  });
  it("emits deletion suggestion block when suggestion is empty string", () => {
    const result = formatCommentWithSuggestion(
      "Delete this line",
      "warning",
      "",
      "const x = 1;",
      "added",
      5,
      undefined,
    );
    expect(result).toContain("```suggestion:-0+0");
    expect(result).toContain("```");
    expect(result).toContain("[WARNING] Delete this line");
  });

  it("emits multi-line suggestion block with correct fence spec", () => {
    const result = formatCommentWithSuggestion(
      "Refactor block",
      "critical",
      "const a = 1;\nconst b = 2;",
      "var a = 1;\nvar b = 2;",
      "added",
      10,
      11,
    );
    expect(result).toContain("```suggestion:-0+1");
  });

  it("returns plain header when originalSnippet is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Missing snippet",
      "info",
      "replacement",
      undefined,
      "added",
      3,
      undefined,
    );
    expect(result).toBe("[INFO] Missing snippet");
    expect(result).not.toContain("```suggestion");
  });

  it("returns plain header when lineType is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Unknown line type",
      "warning",
      "fix",
      "original",
      undefined,
      7,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
  });

  it("returns plain header when lineNumber is undefined", () => {
    const result = formatCommentWithSuggestion(
      "No line number",
      "warning",
      "fix",
      "original",
      "added",
      undefined,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
  });

  it("context lineType allows suggestion block", () => {
    const result = formatCommentWithSuggestion(
      "Context suggestion",
      "info",
      "improved line",
      "original line",
      "context",
      20,
      undefined,
    );
    expect(result).toContain("```suggestion:-0+0");
    expect(result).toContain("improved line");
  });

  it("suggestion block is separated from header by blank line", () => {
    const result = formatCommentWithSuggestion(
      "Fix this",
      "warning",
      "fixed",
      "broken",
      "added",
      1,
      undefined,
    );
    expect(result).toContain("[WARNING] Fix this\n\n```suggestion");
  });

  it("suggestion block ends with closing fence", () => {
    const result = formatCommentWithSuggestion(
      "Fix this",
      "warning",
      "fixed code",
      "broken code",
      "added",
      1,
      undefined,
    );
    expect(result).toMatch(/```$/);
  });

  it("multi-line span of 3 lines produces fence spec -0+2", () => {
    const result = formatCommentWithSuggestion(
      "Three lines",
      "info",
      "a\nb\nc",
      "x\ny\nz",
      "added",
      1,
      3,
    );
    expect(result).toContain("```suggestion:-0+2");
  });
});
