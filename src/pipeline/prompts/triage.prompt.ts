interface TriageHunkInput {
  body: string;
  filePath: string;
  header: string;
  id: number;
}

interface TriageVerdictItem {
  hunkId: number;
  verdict: "needs-review" | "trivial";
}

const TRIAGE_SYSTEM_PROMPT = [
  "Pre-review triage: classify each unified-diff hunk as trivial or needs-review.",
  "",
  "trivial (patterns, not exhaustive): whitespace or EOL-only; formatting-only (Prettier, quote style, wrapping); import reorder/sort without code changes; renaming a strictly local identifier when exports/public API and external names are unchanged; reordering object/JSON entries or props when semantics are unchanged; copy, translation, or UI string edits when i18n keys, route names, and identifiers stay the same; Tailwind/CSS class reorder or equivalent swap when layout and behaviour are unchanged; pure move or split of code with no behavioural change.",
  "",
  "needs-review (small diffs can still matter): any control flow, condition, loop, await, try/catch, or error path; comparison or boolean logic; env names/values, URLs, timeouts, TTLs, rate limits, feature flags; auth, security, validation, middleware, guards, routes; Prisma/schema/migrations/DDL; exported symbols, public signatures, or types used across files; IO (DB, network, disk, logging level that affects prod); concurrency; anything that might change observability, security posture, or data on the wire.",
  "",
  "Label trivial only if you could explain in one short phrase why runtime behaviour (including security and side effects) stays the same; otherwise choose needs-review.",
  "",
  "When uncertain, prefer needs-review over trivial.",
  "",
  'Respond with valid JSON only: { "results": [ { "hunk_id": <int>, "verdict": "trivial" | "needs-review" } ] }. Include every hunk_id from the input exactly once.',
].join("\n");

function buildTriageUserPrompt(hunks: readonly TriageHunkInput[]): string {
  const sections = hunks.map((hunk) => {
    return [`Hunk ${hunk.id}: ${hunk.filePath}`, hunk.header, hunk.body].join(
      "\n",
    );
  });

  return [
    `Classify the following ${hunks.length.toString()} hunk(s):`,
    "",
    "Each numbered block below is one hunk; use the file path together with added/removed lines.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}

function buildTriageSystemPrompt(): string {
  return TRIAGE_SYSTEM_PROMPT;
}

export { buildTriageSystemPrompt, buildTriageUserPrompt };
export type { TriageHunkInput, TriageVerdictItem };
