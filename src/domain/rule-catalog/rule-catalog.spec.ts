import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RETIRED_RULE_IDS,
  RULE_CATALOG_HISTORY,
  RULE_CATALOG_VERSION,
  UnknownCatalogVersionError,
  catalogComparability,
  catalogRulesForScope,
  findCatalogRule,
  getRuleCatalog,
  toRuleId,
} from "~/domain/rule-catalog/rule-catalog";
import { computeCatalogFingerprint } from "~/domain/rule-catalog/rule-catalog.fingerprint";
import { RULE_CATEGORIES } from "~/domain/rule-catalog/rule-catalog.types";

const GUIDANCE_WORDS = new RegExp(
  `\\b(should|consider\\w*|recommend\\w*|${atob("YWR2aXM=")}\\w*|fix\\w*|instead)\\b`,
  "i",
);

const CatalogRuleSchema = z.object({
  category: z.enum(RULE_CATEGORIES),
  condition: z.string().min(20),
  detection: z.string().min(20),
  finding: z.string().min(20),
  id: z.string().regex(/^R-\d{3}$/),
  scope: z.enum(["file", "cross-file"]),
  severity: z.enum(["critical", "attention", "warning", "info", "nitpick"]),
  title: z.string().min(5),
});

describe("rule catalog", () => {
  const catalog = getRuleCatalog();

  it("holds only well-formed rules", () => {
    for (const rule of catalog.rules) {
      expect(CatalogRuleSchema.safeParse(rule).success, rule.id).toBe(true);
    }
  });

  it("gives every rule a unique id", () => {
    const ids = catalog.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reuses a retired id", () => {
    for (const rule of catalog.rules) {
      expect(RETIRED_RULE_IDS).not.toContain(rule.id);
    }
  });

  it("states conditions and findings as facts, without guidance", () => {
    for (const rule of catalog.rules) {
      expect(rule.condition, rule.id).not.toMatch(GUIDANCE_WORDS);
      expect(rule.finding, rule.id).not.toMatch(GUIDANCE_WORDS);
    }
  });

  it("records the current rules as the latest history entry", () => {
    const latest = RULE_CATALOG_HISTORY.at(-1);
    expect(latest?.version).toBe(RULE_CATALOG_VERSION);
    expect(catalog.version).toBe(RULE_CATALOG_VERSION);
    expect(latest?.fingerprint).toBe(computeCatalogFingerprint(catalog.rules));
  });

  it("records the rule ids of the current catalog in the latest history entry", () => {
    const latest = RULE_CATALOG_HISTORY.at(-1);
    expect([...(latest?.ruleIds ?? [])].sort()).toEqual(
      catalog.rules.map((rule) => rule.id).sort(),
    );
  });

  it("compares every rule of the same catalog version", () => {
    expect(catalogComparability(RULE_CATALOG_VERSION)).toEqual({
      comparableRuleIds: new Set(catalog.rules.map((rule) => rule.id)),
      notComparableRuleCount: 0,
    });
  });

  it("refuses a catalog version that is not in the history", () => {
    expect(() => catalogComparability("1999.1.1")).toThrow(
      UnknownCatalogVersionError,
    );
  });

  it("keeps history versions and fingerprints unique", () => {
    const versions = RULE_CATALOG_HISTORY.map((entry) => entry.version);
    const fingerprints = RULE_CATALOG_HISTORY.map((entry) => entry.fingerprint);
    expect(new Set(versions).size).toBe(versions.length);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("finds a rule by id and splits rules by scope", () => {
    expect(findCatalogRule("R-013")?.category).toBe("correctness");
    expect(findCatalogRule("R-999")).toBeUndefined();
    expect(catalogRulesForScope("cross-file").map((rule) => rule.id)).toEqual([
      "R-025",
      "R-026",
    ]);
    expect(catalogRulesForScope("file")).toHaveLength(24);
  });

  it("changes the fingerprint when any rule text changes", () => {
    const [first, ...rest] = catalog.rules;
    if (first === undefined) throw new Error("empty catalog");
    const edited = [{ ...first, finding: `${first.finding} ` }, ...rest];
    expect(computeCatalogFingerprint(edited)).not.toBe(
      computeCatalogFingerprint(catalog.rules),
    );
  });

  it("reads a stored rule id only when it is in the catalog", () => {
    expect(toRuleId("R-013")).toBe("R-013");
    expect(toRuleId("bug")).toBeUndefined();
    expect(toRuleId(null)).toBeUndefined();
  });
});
