import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { Finding } from "~/domain/types/review.types";

function formatFindingComment(
  finding: Pick<Finding, "comment" | "ruleId" | "severity">,
  catalogUrl: string | undefined,
): string {
  const title = findCatalogRule(finding.ruleId)?.title ?? finding.ruleId;
  const parts = [
    `**${finding.ruleId} · ${title}** · ${finding.severity}`,
    "",
    finding.comment,
  ];
  if (catalogUrl !== undefined) {
    parts.push("", `Rule: ${catalogUrl}#${finding.ruleId}`);
  }
  return parts.join("\n");
}

export { formatFindingComment };
