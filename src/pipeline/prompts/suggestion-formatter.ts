import type { LineType, Severity } from "~/domain/types/review.types";

function hasSuggestionPayload(suggestion?: string): suggestion is string {
  return suggestion !== undefined && suggestion !== null;
}

function buildSuggestionBlock(
  suggestion: string,
  lineNumber: number,
  endLineNumber: number | undefined
): string {
  const extraLines =
    endLineNumber !== undefined ? endLineNumber - lineNumber : 0;
  const fenceSpec = `-0+${extraLines}`;
  return `\`\`\`suggestion:${fenceSpec}\n${suggestion}\n\`\`\``;
}

function formatCommentWithSuggestion(
  comment: string,
  severity: Severity,
  suggestion?: string,
  originalSnippet?: string,
  lineType?: LineType,
  lineNumber?: number,
  endLineNumber?: number
): string {
  const header = `[${severity.toUpperCase()}] ${comment}`;

  const canEmitSuggestion =
    hasSuggestionPayload(suggestion) &&
    originalSnippet !== undefined &&
    originalSnippet !== null &&
    lineType !== undefined &&
    lineType !== "removed" &&
    lineNumber !== undefined;

  if (!canEmitSuggestion) {
    return header;
  }

  const suggestionBlock = buildSuggestionBlock(
    suggestion,
    lineNumber,
    endLineNumber
  );

  return `${header}\n\n${suggestionBlock}`;
}

export { formatCommentWithSuggestion };
