import { describe, expect, it } from "vitest";

import { buildRuleCatalogInstruction } from "~/pipeline/prompts/rule-catalog.prompt";

describe("buildRuleCatalogInstruction", () => {
  it("lists every file-scope rule with its condition and detection guidance", () => {
    const text = buildRuleCatalogInstruction("file");
    expect(text).toContain("Rule catalog 2026.10.1");
    expect(text).toContain(
      "R-013 · Identifier used but not declared or imported",
    );
    expect(text).toContain("Condition: A function or value is referenced");
    expect(text).toContain("How to detect: For every identifier");
    expect(text).not.toContain("R-025");
  });

  it("lists only cross-file rules for the cross-file pass", () => {
    const text = buildRuleCatalogInstruction("cross-file");
    expect(text).toContain("R-025");
    expect(text).toContain("R-026");
    expect(text).not.toContain("R-013");
  });

  it("forbids anything outside the catalog", () => {
    expect(buildRuleCatalogInstruction("file")).toContain(
      "A condition that matches none of these rules is out of scope and is not reported.",
    );
  });
});
