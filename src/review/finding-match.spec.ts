import { describe, expect, it } from "vitest";

import { findingsMatch, normalizeCategory } from "./finding-match";
import type { MatchableFinding } from "./finding-match";

function make(overrides: Partial<MatchableFinding> = {}): MatchableFinding {
  return {
    category: "bug",
    filePath: "src/a.ts",
    lineNumber: 10,
    lineType: "added",
    ...overrides,
  };
}

describe("findingsMatch", () => {
  it("matches identical findings", () => {
    expect(findingsMatch(make(), make(), 0)).toBe(true);
  });

  it("matches within the line tolerance window", () => {
    expect(findingsMatch(make(), make({ lineNumber: 12 }), 3)).toBe(true);
    expect(findingsMatch(make(), make({ lineNumber: 14 }), 3)).toBe(false);
  });

  it("does not match across different files", () => {
    expect(findingsMatch(make(), make({ filePath: "src/b.ts" }), 3)).toBe(
      false,
    );
  });

  it("does not match across different line types", () => {
    expect(findingsMatch(make(), make({ lineType: "removed" }), 3)).toBe(false);
  });

  it("matches categories case- and whitespace-insensitively", () => {
    expect(findingsMatch(make(), make({ category: "  BUG " }), 0)).toBe(true);
    expect(findingsMatch(make(), make({ category: "security" }), 0)).toBe(
      false,
    );
  });

  it("normalizeCategory lowercases and trims", () => {
    expect(normalizeCategory("  Security ")).toBe("security");
  });
});
