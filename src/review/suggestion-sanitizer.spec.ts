import { describe, expect, it } from "vitest";

import { sanitizeSuggestionAndComment } from "./suggestion-sanitizer";

describe("sanitizeSuggestionAndComment", () => {
  it("moves prose suggestion into comment", () => {
    const actual = sanitizeSuggestionAndComment({
      comment: "Base",
      suggestion:
        "Either remove the injector creation or add the service export via a getter",
    });
    expect(actual.suggestion).toBeUndefined();
    expect(actual.comment).toContain("Base");
    expect(actual.comment).toContain("Either remove the injector creation");
  });

  it("keeps code suggestion intact", () => {
    const actual = sanitizeSuggestionAndComment({
      comment: "Base",
      suggestion: "const value = createValue();",
    });
    expect(actual.suggestion).toBe("const value = createValue();");
    expect(actual.comment).toBe("Base");
  });

  it("keeps empty suggestion for deletion", () => {
    const actual = sanitizeSuggestionAndComment({
      comment: "Delete line",
      suggestion: " \n\t",
    });
    expect(actual.suggestion).toBe("");
    expect(actual.comment).toBe("Delete line");
  });
});
