import type { Finding, Severity } from "~/domain/types/review.types";

interface ModelTokenUsage {
  completionTokens: number;
  promptTokens: number;
}

interface SummaryParams {
  allFindings: Finding[];
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

function buildSummaryNote(params: SummaryParams): string {
  const {
    allFindings,
    overview,
    suppressedCount,
    tokenCostUsd,
    tokenUsageByModel,
  } = params;

  const parts: string[] = [];

  parts.push(`## AI Review Summary\n\n**Overall:** ${overview}`);

  const severityTable = buildSeverityTable(allFindings);
  if (severityTable) {
    parts.push(severityTable);
  }

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
    const head = `${i + 1}. **[${f.severity.toUpperCase()}]** \`${f.filePath}:${f.lineNumber}\` - ${text}`;
    const fix =
      f.suggestion !== undefined && f.suggestion.trim() !== ""
        ? `\n\n   _Suggested fix:_\n\n   \`\`\`suggestion\n${f.suggestion}\n   \`\`\``
        : "";
    return `${head}${fix}`;
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

  const modelLines = Object.entries(tokenUsageByModel)
    .filter(([, usage]) => usage.promptTokens > 0 || usage.completionTokens > 0)
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

  return parts.join("\n\n");
}

export { buildSummaryNote };
export type { ModelTokenUsage, SummaryParams };
