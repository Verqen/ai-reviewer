import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import type { Finding, Severity } from "~/domain/types/review.types";

interface ModelTokenUsage {
  completionTokens: number;
  promptTokens: number;
}

interface SummaryParams {
  allFindings: Finding[];
  catalogUrl?: string | undefined;
  catalogVersion: string;
  includeCostFooter?: boolean;
  overview: string;
  postableFindings: Finding[];
  suppressedCount: number;
  tokenCostUsd?: number;
  tokenUsageByModel: Record<string, ModelTokenUsage>;
}

function normalizeCommentForSummaryLine(comment: string): string {
  return comment.replace(/\r?\n/g, " ").trim();
}

const SEVERITY_LABEL: Record<Severity, string> = {
  attention: "Attention",
  critical: "Critical",
  info: "Info",
  nitpick: "Nitpick",
  warning: "Warning",
};

function buildSeverityTable(findings: Finding[]): string {
  const counts: Record<Severity, number> = {
    attention: 0,
    critical: 0,
    info: 0,
    nitpick: 0,
    warning: 0,
  };

  for (const f of findings) {
    counts[f.severity]++;
  }

  const rows = (
    ["critical", "attention", "warning", "info", "nitpick"] as Severity[]
  )
    .filter((s) => counts[s] > 0)
    .map((s) => `| ${SEVERITY_LABEL[s]} | ${counts[s]} |`)
    .join("\n");

  if (!rows) {
    return "";
  }

  return `| Severity | Count |\n|----------|-------|\n${rows}`;
}

function buildRuleTable(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, count]) =>
        `| ${id} | ${findCatalogRule(id)?.title ?? id} | ${String(count)} |`,
    );
  return rows.length === 0
    ? ""
    : `| Rule | Title | Count |\n|------|-------|-------|\n${rows.join("\n")}`;
}

function buildCatalogLine(
  catalogVersion: string,
  catalogUrl: string | undefined,
): string {
  return catalogUrl === undefined
    ? `Rule catalog ${catalogVersion}`
    : `Rule catalog ${catalogVersion}: ${catalogUrl}`;
}

function buildSummaryNote(params: SummaryParams): string {
  const {
    allFindings,
    catalogUrl,
    catalogVersion,
    includeCostFooter = false,
    overview,
    suppressedCount,
    tokenCostUsd,
    tokenUsageByModel,
  } = params;

  const parts: string[] = [];

  parts.push(`## Verqen check summary\n\n**Overall:** ${overview}`);

  const severityTable = buildSeverityTable(allFindings);
  if (severityTable) {
    parts.push(severityTable);
  }

  const ruleTable = buildRuleTable(allFindings);
  if (ruleTable) {
    parts.push(ruleTable);
  }

  parts.push(buildCatalogLine(catalogVersion, catalogUrl));

  if (suppressedCount > 0) {
    parts.push(
      `*${suppressedCount} finding(s) suppressed by dismissed patterns.*`,
    );
  }

  const isVisible = (f: Finding): boolean =>
    f.severity === "critical" ||
    f.severity === "attention" ||
    f.severity === "warning";
  const formatItem = (f: Finding, i: number): string => {
    const text = normalizeCommentForSummaryLine(f.comment);
    return `${i + 1}. **${f.ruleId}** [${f.severity.toUpperCase()}] \`${f.filePath}:${f.lineNumber}\` - ${text}`;
  };

  const fileFindings = allFindings.filter(
    (f) => isVisible(f) && f.passName === "file-review",
  );
  if (fileFindings.length > 0) {
    parts.push(
      `### File Findings\n\n${fileFindings.map(formatItem).join("\n")}`,
    );
  }

  const archFindings = allFindings.filter(
    (f) => isVisible(f) && f.passName === "cross-file",
  );
  if (archFindings.length > 0) {
    parts.push(
      `### Architecture Findings\n\n${archFindings.map(formatItem).join("\n")}`,
    );
  }

  const otherFindings = allFindings.filter(
    (f) =>
      isVisible(f) &&
      f.passName !== "file-review" &&
      f.passName !== "cross-file",
  );
  if (otherFindings.length > 0) {
    parts.push(
      `### Other Findings\n\n${otherFindings.map(formatItem).join("\n")}`,
    );
  }

  if (includeCostFooter) {
    const modelLines = Object.entries(tokenUsageByModel)
      .filter(
        ([, usage]) => usage.promptTokens > 0 || usage.completionTokens > 0,
      )
      .map(
        ([modelName, usage]) =>
          `- \`${modelName}\`: ${usage.promptTokens.toLocaleString("en-US")} in / ${usage.completionTokens.toLocaleString("en-US")} out`,
      );
    const tokensSection =
      modelLines.length > 0
        ? `**Tokens by model:**\n${modelLines.join("\n")}`
        : "**Tokens by model:** none";

    const costSection =
      tokenCostUsd !== undefined && tokenCostUsd > 0
        ? `\n**Estimated LLM cost:** $${tokenCostUsd.toFixed(4)}`
        : "";

    parts.push(`---\n${tokensSection}${costSection}`);
  }

  return parts.join("\n\n");
}

export { buildSummaryNote };
export type { ModelTokenUsage, SummaryParams };
