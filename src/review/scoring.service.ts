import type { Finding, Severity } from "~/domain/types/review.types";

/**
 * Production-readiness score (0–100) + A–F grade, derived deterministically from
 * the findings of a scan. This is the headline product artifact: the same set
 * of findings always yields the same score. See architecture §5 for the frozen
 * weights and the critical-security cap.
 */

type ScoreCategory =
  | "Architecture"
  | "Deployment readiness"
  | "Performance"
  | "Security"
  | "Type Safety";

type Grade = "A" | "B" | "C" | "D" | "F";

interface CategoryBreakdown {
  category: ScoreCategory;
  findingCount: number;
  subscore: number;
  weight: number;
}

interface ProductionReadinessScore {
  breakdown: CategoryBreakdown[];
  grade: Grade;
  score: number;
}

/** Weights sum to 1.0 (architecture §5). Order is the UI display order. */
const SCORE_CATEGORIES: readonly ScoreCategory[] = [
  "Security",
  "Architecture",
  "Type Safety",
  "Deployment readiness",
  "Performance",
];

const CATEGORY_WEIGHT: Record<ScoreCategory, number> = {
  Architecture: 0.2,
  "Deployment readiness": 0.15,
  Performance: 0.15,
  Security: 0.35,
  "Type Safety": 0.15,
};

/** Points deducted from a category's 100 baseline per finding of each severity. */
const SEVERITY_PENALTY: Record<Severity, number> = {
  attention: 20,
  critical: 40,
  info: 3,
  nitpick: 1,
  warning: 10,
};

/**
 * Maps a finding's lowercase category token (the prompt's category vocabulary)
 * onto one of the five score categories. Anything unmapped (bug, validation,
 * observability, style, …) counts toward general production readiness.
 */
const FINDING_CATEGORY_TO_SCORE: Record<string, ScoreCategory> = {
  architecture: "Architecture",
  concurrency: "Performance",
  contract: "Architecture",
  performance: "Performance",
  security: "Security",
  types: "Type Safety",
};

const DEFAULT_SCORE_CATEGORY: ScoreCategory = "Deployment readiness";

const MAX_SUBSCORE = 100;

/**
 * A single critical security finding caps the whole score (architecture §5):
 * a lone exposed key must never yield a passing grade.
 */
const CRITICAL_SECURITY_SCORE_CAP = 40;

const GRADE_THRESHOLDS: ReadonlyArray<{ grade: Grade; min: number }> = [
  { grade: "A", min: 85 },
  { grade: "B", min: 70 },
  { grade: "C", min: 55 },
  { grade: "D", min: 40 },
];

function toScoreCategory(category: string): ScoreCategory {
  return (
    FINDING_CATEGORY_TO_SCORE[category.toLowerCase().trim()] ??
    DEFAULT_SCORE_CATEGORY
  );
}

function gradeForScore(score: number): Grade {
  for (const threshold of GRADE_THRESHOLDS) {
    if (score >= threshold.min) {
      return threshold.grade;
    }
  }
  return "F";
}

function computeProductionReadinessScore(
  findings: ReadonlyArray<Pick<Finding, "category" | "severity">>,
): ProductionReadinessScore {
  const penaltyByCategory = new Map<ScoreCategory, number>();
  const countByCategory = new Map<ScoreCategory, number>();
  let hasCriticalSecurity = false;

  for (const finding of findings) {
    const category = toScoreCategory(finding.category);
    penaltyByCategory.set(
      category,
      (penaltyByCategory.get(category) ?? 0) +
        SEVERITY_PENALTY[finding.severity],
    );
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
    if (category === "Security" && finding.severity === "critical") {
      hasCriticalSecurity = true;
    }
  }

  const breakdown: CategoryBreakdown[] = SCORE_CATEGORIES.map((category) => ({
    category,
    findingCount: countByCategory.get(category) ?? 0,
    subscore: Math.max(
      0,
      MAX_SUBSCORE - (penaltyByCategory.get(category) ?? 0),
    ),
    weight: CATEGORY_WEIGHT[category],
  }));

  const weighted = breakdown.reduce(
    (sum, entry) => sum + entry.weight * entry.subscore,
    0,
  );
  let score = Math.round(weighted);
  if (hasCriticalSecurity) {
    score = Math.min(score, CRITICAL_SECURITY_SCORE_CAP);
  }

  return { breakdown, grade: gradeForScore(score), score };
}

export { computeProductionReadinessScore };
export type {
  CategoryBreakdown,
  Grade,
  ProductionReadinessScore,
  ScoreCategory,
};
