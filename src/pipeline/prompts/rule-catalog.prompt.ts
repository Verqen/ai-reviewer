import {
  RULE_CATALOG_VERSION,
  catalogRulesForScope,
} from "~/domain/rule-catalog/rule-catalog";
import type { RuleScope } from "~/domain/rule-catalog/rule-catalog.types";

function buildRuleCatalogInstruction(scope: RuleScope): string {
  const rules = catalogRulesForScope(scope).map((rule) =>
    [
      `${rule.id} · ${rule.title}`,
      `  Condition: ${rule.condition}`,
      `  How to detect: ${rule.detection}`,
    ].join("\n"),
  );
  return [
    `Rule catalog ${RULE_CATALOG_VERSION}. Report only conditions that match one of these rules, and name the rule by its id.`,
    "A condition that matches none of these rules is out of scope and is not reported.",
    "",
    ...rules,
  ].join("\n");
}

function buildRuleIdList(scope: RuleScope): string {
  return catalogRulesForScope(scope)
    .map((rule) => `${rule.id} (${rule.title})`)
    .join(", ");
}

export { buildRuleCatalogInstruction, buildRuleIdList };
