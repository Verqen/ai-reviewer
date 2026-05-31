import { describe, expect, it } from "vitest";

import type { Finding } from "~/domain/types/review.types";

import { buildSummaryNote } from "./summary.prompt";
import type { SummaryParams } from "./summary.prompt";

function buildFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "bug",
    comment: "Test issue",
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    severity: "warning",
    ...overrides,
  };
}

function buildParams(overrides: Partial<SummaryParams> = {}): SummaryParams {
  return {
    allFindings: [],
    overview: "AI review complete — no issues found.",
    postableFindings: [],
    suppressedCount: 0,
    tokenUsageByModel: {
      "claude-sonnet-4.6": { completionTokens: 100, promptTokens: 500 },
    },
    ...overrides,
  };
}

describe("buildSummaryNote", () => {
  it("includes overall assessment", () => {
    const note = buildSummaryNote(
      buildParams({ overview: "No issues found." })
    );
    expect(note).toContain("**Overall:** No issues found.");
  });

  it("includes severity table when findings present", () => {
    const findings = [
      buildFinding({ severity: "critical" }),
      buildFinding({ lineNumber: 2, severity: "attention" }),
      buildFinding({ lineNumber: 3, severity: "warning" }),
    ];
    const note = buildSummaryNote(
      buildParams({ allFindings: findings, postableFindings: findings })
    );
    expect(note).toContain("| Critical | 1 |");
    expect(note).toContain("| Attention | 1 |");
    expect(note).toContain("| Warning | 1 |");
  });

  it("omits severity table when no findings", () => {
    const note = buildSummaryNote(buildParams());
    expect(note).not.toContain("| Severity | Count |");
  });

  it("includes File Findings section with critical, attention, and warning findings", () => {
    const findings = [
      buildFinding({
        comment: "SQL injection risk",
        filePath: "src/auth.ts",
        lineNumber: 42,
        severity: "critical",
      }),
      buildFinding({
        comment: "Potential consistency drift",
        filePath: "src/billing.ts",
        lineNumber: 17,
        severity: "attention",
      }),
      buildFinding({
        comment: "Missing transaction",
        filePath: "src/order.ts",
        lineNumber: 10,
        severity: "warning",
      }),
      buildFinding({
        comment: "Info finding",
        lineNumber: 3,
        severity: "info",
      }),
    ];
    const note = buildSummaryNote(buildParams({ allFindings: findings }));
    expect(note).toContain("### File Findings");
    expect(note).toContain("[CRITICAL]");
    expect(note).toContain("src/auth.ts:42");
    expect(note).toContain("[ATTENTION]");
    expect(note).toContain("src/billing.ts:17");
    expect(note).toContain("[WARNING]");
    expect(note).not.toContain("[INFO]");
  });

  it("lists all visible file-review findings without truncating count", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      buildFinding({
        comment: `Issue ${String(i)}`,
        lineNumber: i + 1,
        severity: "warning",
      })
    );
    const note = buildSummaryNote(buildParams({ allFindings: findings }));
    const matches = note.match(/\[WARNING\]/g);
    expect(matches).toHaveLength(10);
  });

  it("includes full finding comment text without ellipsis truncation", () => {
    const longComment = `x`.repeat(200);
    const note = buildSummaryNote(
      buildParams({
        allFindings: [
          buildFinding({ comment: longComment, severity: "critical" }),
        ],
      })
    );
    expect(note).toContain(longComment);
    expect(note).not.toContain("…");
  });

  it("normalizes multiline comments to single line in summary list", () => {
    const note = buildSummaryNote(
      buildParams({
        allFindings: [
          buildFinding({
            comment: "First line.\nSecond line.\nThird.",
            severity: "warning",
          }),
        ],
      })
    );
    expect(note).toContain("`src/a.ts:1` - First line. Second line. Third.");
  });


  it("displays per-model token breakdown in footer", () => {
    const note = buildSummaryNote(
      buildParams({
        tokenUsageByModel: {
          "review-model": { completionTokens: 200, promptTokens: 800 },
          "triage-model": { completionTokens: 100, promptTokens: 400 },
        },
      })
    );
    expect(note).not.toMatch(/Cost:/i);
    expect(note).toContain("review-model");
    expect(note).toContain("800");
    expect(note).toContain("200");
    expect(note).toContain("triage-model");
    expect(note).toContain("400");
    expect(note).toContain("100");
  });

  it("does NOT include 'Reviewed by AI Reviewer' filler", () => {
    const note = buildSummaryNote(buildParams());
    expect(note).not.toContain("Reviewed by AI Reviewer");
  });

  it("shows suppressed count when non-zero", () => {
    const note = buildSummaryNote(buildParams({ suppressedCount: 3 }));
    expect(note).toContain("3 finding(s) suppressed by dismissed patterns");
  });

  it("renders all file-review and cross-file findings in separate sections", () => {
    const fileFindings: Finding[] = Array.from({ length: 6 }, (_, i) =>
      buildFinding({
        comment: `File issue ${String(i)}`,
        filePath: "src/feature.ts",
        lineNumber: i + 1,
        passName: "file-review",
        severity: "critical",
      })
    );
    const crossFindings: Finding[] = Array.from({ length: 6 }, (_, i) =>
      buildFinding({
        comment: `Architecture issue ${String(i)}`,
        filePath: "src/arch.ts",
        lineNumber: i + 1,
        passName: "cross-file",
        severity: "critical",
      })
    );
    const note = buildSummaryNote(
      buildParams({ allFindings: [...fileFindings, ...crossFindings] })
    );
    expect(note).toContain("### File Findings");
    expect(note).toContain("### Architecture Findings");
    const fileSectionIdx = note.indexOf("### File Findings");
    const archSectionIdx = note.indexOf("### Architecture Findings");
    const fileSection = note.slice(fileSectionIdx, archSectionIdx);
    const archSection = note.slice(archSectionIdx);
    const fileItems = fileSection.match(/\n\d+\. \*\*\[CRITICAL\]\*\*/g) ?? [];
    const archItems = archSection.match(/\n\d+\. \*\*\[CRITICAL\]\*\*/g) ?? [];
    expect(fileItems).toHaveLength(6);
    expect(archItems).toHaveLength(6);
    expect(fileSection).toContain("File issue 0");
    expect(archSection).toContain("Architecture issue 0");
  });
});
