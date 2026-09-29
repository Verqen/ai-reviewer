import { DEFAULT_PRODUCT_NAME } from "~/domain/product-name";
import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { CatalogRule } from "~/domain/rule-catalog/rule-catalog.types";

function serviceStatement(productName: string): string {
  return `${productName} is an automated check against a published rule catalog and does not answer questions`;
}

function buildRuleThreadReply(
  rule: CatalogRule,
  catalogUrl: string | undefined,
  productName: string,
): string {
  const link = catalogUrl === undefined ? "" : ` ${catalogUrl}#${rule.id}`;
  return `${serviceStatement(productName)} about findings. Rule ${rule.id}: ${rule.condition}${link}`;
}

function buildFindingThreadReply(
  ruleId: string | undefined | null,
  catalogUrl: string | undefined,
  productName: string = DEFAULT_PRODUCT_NAME,
): string {
  const rule =
    ruleId === undefined || ruleId === null
      ? undefined
      : findCatalogRule(ruleId);
  return rule === undefined
    ? ""
    : buildRuleThreadReply(rule, catalogUrl, productName);
}

function buildMentionReply(
  catalogUrl: string | undefined,
  productName: string = DEFAULT_PRODUCT_NAME,
): string {
  const link = catalogUrl === undefined ? "" : ` Rule catalog: ${catalogUrl}`;
  return `${serviceStatement(productName)}.${link}`;
}

export { buildFindingThreadReply, buildMentionReply };
