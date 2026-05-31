import { describe, expect, it } from "vitest";

import type { Finding, Severity } from "~/domain/types/review.types";
import {
  buildVibeCodingPatternsInstruction,
  escalateVibeCodingSeverity,
} from "~/pipeline/prompts/vibe-coding-patterns";

function finding(
  overrides: Partial<Finding> & { severity: Severity },
): Finding {
  return {
    category: "best_practice",
    comment: "",
    confidence: 0.6,
    filePath: "src/a.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test",
    passName: "file-review",
    ...overrides,
  };
}

describe("escalateVibeCodingSeverity", () => {
  it("escalates an under-rated exposed secret to critical security", () => {
    const [result] = escalateVibeCodingSeverity([
      finding({
        originalSnippet: 'const k = "sk_live_51hxabcdefghij";',
        severity: "nitpick",
      }),
    ]);
    expect(result?.severity).toBe("critical");
    expect(result?.category).toBe("security");
  });

  it("escalates eval() on input to critical", () => {
    const [result] = escalateVibeCodingSeverity([
      finding({ originalSnippet: "eval(req.body.code)", severity: "warning" }),
    ]);
    expect(result?.severity).toBe("critical");
  });

  it("escalates a wildcard CORS finding to attention", () => {
    const [result] = escalateVibeCodingSeverity([
      finding({
        comment: "Access-Control-Allow-Origin: * exposes the API",
        severity: "info",
      }),
    ]);
    expect(result?.severity).toBe("attention");
  });

  it("escalates an RLS comment to critical", () => {
    const [result] = escalateVibeCodingSeverity([
      finding({
        comment: "This Supabase table has no row level security policy",
        severity: "warning",
      }),
    ]);
    expect(result?.severity).toBe("critical");
  });

  it("never downgrades a finding already above the pattern minimum", () => {
    const [result] = escalateVibeCodingSeverity([
      finding({
        comment: "CORS wildcard",
        originalSnippet: 'origin: "*"',
        severity: "critical",
      }),
    ]);
    expect(result?.severity).toBe("critical");
  });

  it("leaves non-matching findings untouched", () => {
    const input = finding({
      comment: "rename this variable",
      severity: "nitpick",
    });
    const [result] = escalateVibeCodingSeverity([input]);
    expect(result).toEqual(input);
  });
});

describe("buildVibeCodingPatternsInstruction", () => {
  it("lists the security patterns for the prompt", () => {
    const text = buildVibeCodingPatternsInstruction();
    expect(text).toContain("Exposed API keys");
    expect(text).toContain("Row Level Security");
    expect(text).toContain("[security]");
  });
});
