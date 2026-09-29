import { describe, expect, it } from "vitest";

import { findingsMatch } from "./finding-match";
import type { MatchableFinding } from "./finding-match";

function make(overrides: Partial<MatchableFinding> = {}): MatchableFinding {
  return {
    filePath: "src/a.ts",
    lineNumber: 10,
    lineType: "added",
    ruleId: "R-013",
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

  it("matches only the same rule", () => {
    expect(findingsMatch(make(), make({ ruleId: "R-014" }), 0)).toBe(false);
  });

  it("never matches a finding without a rule id", () => {
    expect(
      findingsMatch(
        make({ ruleId: undefined }),
        make({ ruleId: undefined }),
        0,
      ),
    ).toBe(false);
    expect(findingsMatch(make(), make({ ruleId: undefined }), 0)).toBe(false);
  });
});
