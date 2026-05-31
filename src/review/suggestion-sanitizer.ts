type SanitizeSuggestionAndCommentParams = {
  comment: string;
  suggestion?: string | null | undefined;
};

type SanitizeSuggestionAndCommentResult = {
  comment: string;
  suggestion?: string | undefined;
};

const CODE_SIGNAL_PATTERN =
  /[{}()[\];=<>]|=>|^\s*(const|let|var|if|for|while|return|import|export|class|interface|type|await|try|catch)\b/m;
const CYRILLIC_PATTERN = /[А-Яа-яЁё]/;
const MIN_PROSE_WORD_COUNT = 8;

function normalizeForComparison(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (!fenceMatch?.[1]) {
    return value;
  }
  return fenceMatch[1];
}

function isLikelyProse(value: string): boolean {
  if (CODE_SIGNAL_PATTERN.test(value)) {
    return false;
  }
  if (CYRILLIC_PATTERN.test(value)) {
    return true;
  }
  const words = value
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length >= MIN_PROSE_WORD_COUNT;
}

function sanitizeSuggestionAndComment(
  params: SanitizeSuggestionAndCommentParams
): SanitizeSuggestionAndCommentResult {
  const normalizedComment = normalizeForComparison(params.comment);
  if (params.suggestion === undefined || params.suggestion === null) {
    return { comment: params.comment };
  }
  const unfencedSuggestion = stripFence(params.suggestion);
  const normalizedSuggestion = normalizeForComparison(unfencedSuggestion);
  if (normalizedSuggestion.length === 0) {
    return { comment: params.comment, suggestion: "" };
  }
  if (normalizedSuggestion === normalizedComment) {
    return { comment: params.comment };
  }
  if (!isLikelyProse(normalizedSuggestion)) {
    return { comment: params.comment, suggestion: unfencedSuggestion };
  }
  const mergedComment =
    normalizedComment.length === 0
      ? normalizedSuggestion
      : `${params.comment}\n\n${normalizedSuggestion}`;
  return { comment: mergedComment };
}

export { sanitizeSuggestionAndComment };
