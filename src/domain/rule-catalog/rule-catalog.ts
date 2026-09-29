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
    ruleIds: [
      "R-001",
      "R-002",
      "R-003",
      "R-004",
      "R-005",
      "R-006",
      "R-007",
      "R-008",
      "R-009",
      "R-010",
      "R-011",
      "R-012",
      "R-013",
      "R-014",
      "R-015",
      "R-016",
      "R-017",
      "R-018",
      "R-019",
      "R-020",
      "R-021",
      "R-022",
      "R-023",
      "R-024",
      "R-025",
      "R-026",
    ],
    version: "2026.10.1",
  },
];

class UnknownCatalogVersionError extends Error {
  override readonly name = "UnknownCatalogVersionError";

  constructor(readonly version: string) {
    super(`Rule catalog version ${version} is not in the catalog history`);
  }
}

interface CatalogComparability {
  comparableRuleIds: ReadonlySet<string>;
  notComparableRuleCount: number;
}

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

function toRuleId(value: string | null): RuleId | undefined {
  return value === null ? undefined : findCatalogRule(value)?.id;
}

function catalogRulesForScope(scope: RuleScope): readonly CatalogRule[] {
  return CATALOG_RULES.filter((rule) => rule.scope === scope);
}

function catalogComparability(baselineVersion: string): CatalogComparability {
  const entry = RULE_CATALOG_HISTORY.find(
    (candidate) => candidate.version === baselineVersion,
  );
  if (entry === undefined)
    throw new UnknownCatalogVersionError(baselineVersion);
  const currentIds = new Set<string>(CATALOG_RULES.map((rule) => rule.id));
  const comparableRuleIds = new Set<string>(
    entry.ruleIds.filter((id) => currentIds.has(id)),
  );
  const allIds = new Set<string>([...entry.ruleIds, ...currentIds]);
  return {
    comparableRuleIds,
    notComparableRuleCount: allIds.size - comparableRuleIds.size,
  };
}

export {
  RETIRED_RULE_IDS,
  RULE_CATALOG_HISTORY,
  RULE_CATALOG_VERSION,
  UnknownCatalogVersionError,
  catalogComparability,
  catalogRulesForScope,
  findCatalogRule,
  getRuleCatalog,
  toRuleId,
};
export type { CatalogComparability };
