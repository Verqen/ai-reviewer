type ProseTriageVerdict = "needs-review" | "trivial";

interface ProseTriageItem {
  hunk_id: number;
  verdict: ProseTriageVerdict;
}

interface ProseTriageResponse {
  results: ProseTriageItem[];
}

interface ProseFallbackContext {
  expectedHunkIds?: readonly number[];
}

interface HunkHeaderMatch {
  hunkId: number;
  sectionStart: number;
}

const BOLD_HUNK_HEADER_RE = /\*\*\s*hunk\s+(\d+)\b[^*]*\*\*/gi;
const PLAIN_HUNK_HEADER_RE = /(?:^|\n)\s*hunk\s+(\d+)\s*[:.\s]/gi;

const NEEDS_REVIEW_SIGNALS: readonly RegExp[] = [
  /\bnot\s+trivial\b/,
  /\bnon-?trivial\b/,
  /\bneeds[\s-]review\b/,
];

const TRIVIAL_SIGNALS: readonly RegExp[] = [
  /\bis\s+trivial\b/,
  /(?:^|[^a-z])trivial(?=[^a-z]|$)/,
];

function inferVerdict(textLower: string): ProseTriageVerdict {
  for (const re of NEEDS_REVIEW_SIGNALS) {
    if (re.test(textLower)) {
      return "needs-review";
    }
  }
  for (const re of TRIVIAL_SIGNALS) {
    if (re.test(textLower)) {
      return "trivial";
    }
  }
  return "needs-review";
}

function findHunkHeaders(rawContent: string): HunkHeaderMatch[] {
  for (const headerRe of [BOLD_HUNK_HEADER_RE, PLAIN_HUNK_HEADER_RE]) {
    const matches = [...rawContent.matchAll(headerRe)];
    if (matches.length === 0) {
      continue;
    }
    const found: HunkHeaderMatch[] = [];
    for (const match of matches) {
      if (match.index === undefined) {
        continue;
      }
      const idStr = match[1];
      if (idStr === undefined) {
        continue;
      }
      const hunkId = Number(idStr);
      if (!Number.isInteger(hunkId) || hunkId < 0) {
        continue;
      }
      found.push({ hunkId, sectionStart: match.index + match[0].length });
    }
    if (found.length > 0) {
      return found;
    }
  }
  return [];
}

function parseFromHeaders(
  rawContent: string,
  headers: readonly HunkHeaderMatch[]
): ProseTriageItem[] {
  const results: ProseTriageItem[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (header === undefined || seen.has(header.hunkId)) {
      continue;
    }
    seen.add(header.hunkId);

    const sectionEnd = headers[i + 1]?.sectionStart ?? rawContent.length;
    const sectionTextLower = rawContent
      .slice(header.sectionStart, sectionEnd)
      .toLowerCase();

    results.push({
      hunk_id: header.hunkId,
      verdict: inferVerdict(sectionTextLower),
    });
  }

  return results;
}

function parseProseTriageResponse(
  rawContent: string,
  context?: ProseFallbackContext
): ProseTriageResponse | null {
  if (rawContent.length === 0) {
    return null;
  }

  const headers = findHunkHeaders(rawContent);
  if (headers.length > 0) {
    const results = parseFromHeaders(rawContent, headers);
    return results.length > 0 ? { results } : null;
  }

  const expectedIds = context?.expectedHunkIds;
  if (expectedIds !== undefined && expectedIds.length === 1) {
    const onlyId = expectedIds[0];
    if (onlyId !== undefined && Number.isInteger(onlyId) && onlyId >= 0) {
      return {
        results: [
          { hunk_id: onlyId, verdict: inferVerdict(rawContent.toLowerCase()) },
        ],
      };
    }
  }

  return null;
}

export type {
  ProseFallbackContext,
  ProseTriageItem,
  ProseTriageResponse,
  ProseTriageVerdict,
};
export { parseProseTriageResponse };
