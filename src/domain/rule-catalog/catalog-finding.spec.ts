import { describe, expect, it } from "vitest";

import {
  buildCatalogFinding,
  resolveCatalogRule,
} from "~/domain/rule-catalog/catalog-finding";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";

const ANCHOR = {
  confidence: 0.9,
  filePath: "src/a.ts",
  lineNumber: 4,
  lineType: "added" as const,
  model: "m",
  passName: "file-review",
};

describe("resolveCatalogRule", () => {
  it("resolves a known rule in its own scope", () => {
    const resolution = resolveCatalogRule("R-013", "file");
    expect(resolution).toEqual({
      kind: "resolved",
      rule: findCatalogRule("R-013"),
    });
  });

  it("drops an id that is not in the catalog", () => {
    expect(resolveCatalogRule("R-999", "file")).toEqual({
      kind: "dropped",
      reason: "unknown_rule",
    });
    expect(resolveCatalogRule("bug", "file")).toEqual({
      kind: "dropped",
      reason: "unknown_rule",
    });
  });

  it("drops a rule returned by the wrong pass", () => {
    expect(resolveCatalogRule("R-025", "file")).toEqual({
      kind: "dropped",
      reason: "scope_mismatch",
    });
    expect(resolveCatalogRule("R-013", "cross-file")).toEqual({
      kind: "dropped",
      reason: "scope_mismatch",
    });
  });
});

describe("buildCatalogFinding", () => {
  it("takes text, severity and category from the catalog", () => {
    const rule = findCatalogRule("R-020");
    if (rule === undefined) throw new Error("missing rule");
    const finding = buildCatalogFinding(rule, ANCHOR);
    expect(finding).toEqual({
      ...ANCHOR,
      category: "reliability",
      comment: rule.finding,
      ruleId: "R-020",
      severity: "info",
    });
  });
});
