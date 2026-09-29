import { CATALOG_RULES } from "~/domain/rule-catalog/rule-catalog.rules";
import type {
  CatalogRule,
  RuleCatalog,
  RuleCatalogHistoryEntry,
  RuleId,
  RuleScope,
} from "~/domain/rule-catalog/rule-catalog.types";

const RULE_CATALOG_VERSION = "2026.10.1";

const RULE_CATALOG_HISTORY: readonly RuleCatalogHistoryEntry[] = [
  {
    fingerprint:
      "81d3674cd4b9d8addfc2ffd430fa60a43dd5c7bcdf1d2c4ee30e7cead4aab80f",
    version: "2026.10.1",
  },
];

const RETIRED_RULE_IDS: readonly RuleId[] = [];

const RULES_BY_ID: ReadonlyMap<string, CatalogRule> = new Map(
  CATALOG_RULES.map((rule) => [rule.id, rule]),
);

function getRuleCatalog(): RuleCatalog {
  return { rules: CATALOG_RULES, version: RULE_CATALOG_VERSION };
}

function findCatalogRule(id: string): CatalogRule | undefined {
  return RULES_BY_ID.get(id);
}

function catalogRulesForScope(scope: RuleScope): readonly CatalogRule[] {
  return CATALOG_RULES.filter((rule) => rule.scope === scope);
}

export {
  RETIRED_RULE_IDS,
  RULE_CATALOG_HISTORY,
  RULE_CATALOG_VERSION,
  catalogRulesForScope,
  findCatalogRule,
  getRuleCatalog,
};
