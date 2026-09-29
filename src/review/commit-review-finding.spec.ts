import { describe, expect, it } from "vitest";

import { fingerprintFinding } from "~/domain/finding-fingerprint";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { Finding } from "~/domain/types/review.types";
import {
  indexLineTexts,
  toCommitReviewFindings,
} from "~/review/commit-review-finding";

const DIFFS: ParsedFileDiff[] = [
  {
    lines: [
      {
        content: "  return user.name;",
        hunkHeader: "@@ -0,0 +1,1 @@",
        newLine: 1,
        type: "added",
      },
    ],
    newPath: "src/a.ts",
    oldPath: "src/a.ts",
  },
];

function catalogFinding(lineNumber: number): Finding {
  const rule = findCatalogRule("R-014");
  if (rule === undefined) throw new Error("R-014 missing from the catalog");
  return {
    category: rule.category,
    comment: rule.finding,
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber,
    lineType: "added",
    model: "test",
    passName: "file-review",
    ruleId: rule.id,
    severity: rule.severity,
  };
}

describe("toCommitReviewFindings", () => {
  it("carries the catalog condition, the finding text and the fingerprint of the anchored line", () => {
    const rule = findCatalogRule("R-014");

    const { dropped, findings } = toCommitReviewFindings(
      [catalogFinding(1)],
      42,
      indexLineTexts(DIFFS),
    );

    expect(dropped).toEqual([]);
    expect(findings).toEqual([
      {
        condition: rule?.condition,
        filePath: "src/a.ts",
        fingerprint: fingerprintFinding(42, "R-014", "return user.name;"),
        line: 1,
        message: rule?.finding,
        ruleId: "R-014",
        severity: rule?.severity,
      },
    ]);
  });

  it("drops a finding whose anchored line is not in the archive", () => {
    const { dropped, findings } = toCommitReviewFindings(
      [catalogFinding(9)],
      42,
      indexLineTexts(DIFFS),
    );

    expect(findings).toEqual([]);
    expect(dropped).toEqual([
      { filePath: "src/a.ts", line: 9, ruleId: "R-014" },
    ]);
  });
});
