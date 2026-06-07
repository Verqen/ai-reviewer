import type { Finding, Severity } from "~/domain/types/review.types";

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

const SEVERITY_PENALTY: Record<Severity, number> = {
  attention: 20,
  critical: 40,
  info: 3,
  nitpick: 1,
  warning: 10,
};

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

const CRITICAL_SCORE_CAP = 40;

const HIGH_SEVERITY_SCORE_CAP = 75;

const MULTIPLE_HIGH_SEVERITY_SCORE_CAP = 55;

const MULTIPLE_HIGH_SEVERITY_THRESHOLD = 2;

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
  let hasCritical = false;
  let highSeverityCount = 0;

  for (const finding of findings) {
    const category = toScoreCategory(finding.category);
    penaltyByCategory.set(
      category,
      (penaltyByCategory.get(category) ?? 0) +
        SEVERITY_PENALTY[finding.severity],
    );
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + 1);
    if (finding.severity === "critical") {
      hasCritical = true;
    }
    if (finding.severity === "attention") {
      highSeverityCount += 1;
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
  if (hasCritical) {
    score = Math.min(score, CRITICAL_SCORE_CAP);
  } else if (highSeverityCount >= MULTIPLE_HIGH_SEVERITY_THRESHOLD) {
    score = Math.min(score, MULTIPLE_HIGH_SEVERITY_SCORE_CAP);
  } else if (highSeverityCount >= 1) {
    score = Math.min(score, HIGH_SEVERITY_SCORE_CAP);
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
