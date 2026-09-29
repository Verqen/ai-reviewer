import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type {
  CatalogRule,
  RuleScope,
} from "~/domain/rule-catalog/rule-catalog.types";
import type { Finding, LineType } from "~/domain/types/review.types";

type CatalogRuleResolution =
  | { kind: "resolved"; rule: CatalogRule }
  | { kind: "dropped"; reason: "unknown_rule" | "scope_mismatch" };

interface CatalogFindingAnchor {
  confidence: number;
  endLineNumber?: number | undefined;
  filePath: string;
  hunkHeader?: string | undefined;
  lineNumber: number;
  lineType: LineType;
  model: string;
  oldPath?: string | undefined;
  originalSnippet?: string | undefined;
  passName: string;
}

function resolveCatalogRule(
  ruleId: string,
  scope: RuleScope,
): CatalogRuleResolution {
  const rule = findCatalogRule(ruleId);
  if (rule === undefined) return { kind: "dropped", reason: "unknown_rule" };
  if (rule.scope !== scope)
    return { kind: "dropped", reason: "scope_mismatch" };
  return { kind: "resolved", rule };
}

function buildCatalogFinding(
  rule: CatalogRule,
  anchor: CatalogFindingAnchor,
): Finding {
  return {
    ...anchor,
    category: rule.category,
    comment: rule.finding,
    ruleId: rule.id,
    severity: rule.severity,
  };
}

export { buildCatalogFinding, resolveCatalogRule };
export type { CatalogFindingAnchor, CatalogRuleResolution };
