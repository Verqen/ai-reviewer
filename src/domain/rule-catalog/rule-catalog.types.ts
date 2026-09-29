import type { Severity } from "~/domain/types/review.types";

const RULE_CATEGORIES = [
  "security",
  "correctness",
  "reliability",
  "types",
  "architecture",
  "performance",
] as const;

type RuleId = `R-${string}`;
type RuleCategory = (typeof RULE_CATEGORIES)[number];
type RuleScope = "file" | "cross-file";

interface CatalogRule {
  category: RuleCategory;
  condition: string;
  detection: string;
  finding: string;
  id: RuleId;
  scope: RuleScope;
  severity: Severity;
  title: string;
}

interface RuleCatalog {
  rules: readonly CatalogRule[];
  version: string;
}

interface RuleCatalogHistoryEntry {
  fingerprint: string;
  ruleIds: readonly RuleId[];
  version: string;
}

export { RULE_CATEGORIES };
export type {
  CatalogRule,
  RuleCatalog,
  RuleCatalogHistoryEntry,
  RuleCategory,
  RuleId,
  RuleScope,
};
