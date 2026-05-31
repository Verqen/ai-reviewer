import type { Finding, Severity } from "~/domain/types/review.types";

/**
 * The vibe-coding pattern set — single source of truth in code (architecture
 * §4). Each pattern feeds BOTH the review prompt (so the model hunts for it)
 * and a deterministic severity floor applied after extraction: security
 * patterns escalate to their minimum severity regardless of model judgement,
 * so a model that under-rates an exposed key cannot let it through as a nitpick.
 *
 * To add a pattern: edit the architecture §4 table, then add an entry here.
 */
interface VibePattern {
  readonly category: string;
  readonly description: string;
  readonly detect?: RegExp;
  readonly id: string;
  readonly minSeverity: Severity;
}

const VIBE_CODING_PATTERNS: readonly VibePattern[] = [
  {
    category: "security",
    description:
      "Exposed API keys/secrets committed to source or shipped to the frontend bundle (sk-, sk_live_, AIza…, NEXT_PUBLIC_*_KEY/SECRET/TOKEN, service-account JSON).",
    detect:
      /sk_live_[a-z0-9]|\bsk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{10,}|NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN)|"type":\s*"service_account"/,
    id: "exposed-secret",
    minSeverity: "critical",
  },
  {
    category: "security",
    description: "eval() / new Function() / RCE on user-controlled input.",
    detect: /\beval\s*\(|new\s+Function\s*\(/,
    id: "eval-rce",
    minSeverity: "critical",
  },
  {
    category: "security",
    description:
      "Missing Row Level Security (RLS) on Supabase/Firebase tables; tables readable/writable without per-row policy.",
    detect: /row[\s-]?level\s+security|\bRLS\b/i,
    id: "missing-rls",
    minSeverity: "critical",
  },
  {
    category: "security",
    description:
      "CORS '*' on endpoints returning sensitive data; wildcard Access-Control-Allow-Origin.",
    detect: /access-control-allow-origin["'\s:]+\*|origin:\s*["']\*["']/i,
    id: "cors-wildcard",
    minSeverity: "attention",
  },
  {
    category: "security",
    description:
      "Webhook handler with no signature (HMAC) verification before processing the payload.",
    detect:
      /webhook[\s\S]{0,40}(no|missing|without)[\s\S]{0,20}signature|signature[\s\S]{0,20}not\s+verif/i,
    id: "webhook-no-signature",
    minSeverity: "attention",
  },
  {
    category: "security",
    description:
      "Auth flow checks the user is logged in but skips the role/permission (authorization) check.",
    id: "auth-no-authz",
    minSeverity: "attention",
  },
  {
    category: "types",
    description:
      "Broken/loose TypeScript types: `any` proliferation, unsafe casts across module boundaries.",
    id: "loose-types",
    minSeverity: "warning",
  },
  {
    category: "architecture",
    description:
      "Architectural drift: state management that will not scale, cross-file inconsistency as the app grows.",
    id: "architectural-drift",
    minSeverity: "warning",
  },
  {
    category: "error_handling",
    description:
      "Missing error handling / logging / rate limiting on production paths.",
    id: "missing-error-handling",
    minSeverity: "warning",
  },
  {
    category: "performance",
    description:
      "N+1 queries, missing indexes, hard-coded config that should be environment-driven.",
    id: "performance-smells",
    minSeverity: "info",
  },
];

const SEVERITY_RANK: Record<Severity, number> = {
  attention: 3,
  critical: 4,
  info: 1,
  nitpick: 0,
  warning: 2,
};

function buildVibeCodingPatternsInstruction(): string {
  const lines = VIBE_CODING_PATTERNS.map(
    (pattern) => `- [${pattern.category}] ${pattern.description}`,
  );
  return [
    "Actively hunt for these AI-generated ('vibe-coded') failure patterns; they are the most common production defects in AI-written code:",
    ...lines,
  ].join("\n");
}

function matchVibePattern(finding: Finding): VibePattern | undefined {
  const haystack = `${finding.originalSnippet ?? ""}\n${finding.comment}`;
  return VIBE_CODING_PATTERNS.find(
    (pattern) => pattern.detect !== undefined && pattern.detect.test(haystack),
  );
}

/**
 * Deterministic severity floor: when a finding's code/comment matches a
 * detectable vibe-coding pattern, raise its severity to the pattern minimum
 * (never lower) and pin its category, so the production-readiness score and the
 * critical-security cap reflect the real risk even if the model under-rated it.
 */
function escalateVibeCodingSeverity(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    const pattern = matchVibePattern(finding);
    if (
      pattern === undefined ||
      SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[pattern.minSeverity]
    ) {
      return finding;
    }
    return {
      ...finding,
      category: pattern.category,
      severity: pattern.minSeverity,
    };
  });
}

export {
  buildVibeCodingPatternsInstruction,
  escalateVibeCodingSeverity,
  VIBE_CODING_PATTERNS,
};
