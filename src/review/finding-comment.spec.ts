import { describe, expect, it } from "vitest";

import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import { formatFindingComment } from "~/review/finding-comment";

const rule = findCatalogRule("R-013");

describe("formatFindingComment", () => {
  it("renders the rule id, title, severity, catalog text and link", () => {
    expect(
      formatFindingComment(
        {
          comment: rule?.finding ?? "",
          ruleId: "R-013",
          severity: "attention",
        },
        "https://verqen.dev/rules",
      ),
    ).toBe(
      [
        "**R-013 · Identifier used but not declared or imported** · attention",
        "",
        "This identifier is referenced here but is not declared in scope or imported.",
        "",
        "Rule: https://verqen.dev/rules#R-013",
      ].join("\n"),
    );
  });

  it("omits the link without a catalog url", () => {
    expect(
      formatFindingComment(
        {
          comment: rule?.finding ?? "",
          ruleId: "R-013",
          severity: "attention",
        },
        undefined,
      ),
    ).not.toContain("Rule:");
  });
});
