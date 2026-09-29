import type { CatalogRule } from "~/domain/rule-catalog/rule-catalog.types";

const SERVICE_STATEMENT =
  "Verqen is an automated check against a published rule catalog and does not answer questions";

function buildRuleThreadReply(
  rule: CatalogRule,
  catalogUrl: string | undefined,
): string {
  const link = catalogUrl === undefined ? "" : ` ${catalogUrl}#${rule.id}`;
  return `${SERVICE_STATEMENT} about findings. Rule ${rule.id}: ${rule.condition}${link}`;
}

function buildMentionReply(catalogUrl: string | undefined): string {
  const link = catalogUrl === undefined ? "" : ` Rule catalog: ${catalogUrl}`;
  return `${SERVICE_STATEMENT}.${link}`;
}

export { buildMentionReply, buildRuleThreadReply };
