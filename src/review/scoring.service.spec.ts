import { describe, expect, it } from "vitest";

import type { Finding, Severity } from "~/domain/types/review.types";
import { computeProductionReadinessScore } from "~/review/scoring.service";

function finding(category: string, severity: Severity): Finding {
  return {
    category,
    comment: "x",
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test",
    passName: "file-review",
    severity,
  };
}

describe("computeProductionReadinessScore", () => {
  it("scores a clean diff at 100 / grade A", () => {
    const result = computeProductionReadinessScore([]);
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.breakdown.every((b) => b.subscore === 100)).toBe(true);
  });

  it("caps the score at 40 (grade D) for a critical security finding", () => {
    const result = computeProductionReadinessScore([
      finding("security", "critical"),
    ]);
    expect(result.score).toBe(40);
    expect(result.grade).toBe("D");
  });

  it("keeps the cap even when the rest of the code is clean", () => {
    const result = computeProductionReadinessScore([
      finding("security", "critical"),
      finding("types", "nitpick"),
    ]);
    expect(result.score).toBeLessThanOrEqual(40);
    expect(["D", "F"]).toContain(result.grade);
  });

  it("caps the score at 40 (grade D) for a non-security critical finding", () => {
    const result = computeProductionReadinessScore([
      finding("performance", "critical"),
    ]);
    expect(result.score).toBe(40);
    expect(result.grade).toBe("D");
  });

  it("weights security heavier than performance for the same severity", () => {
    const sec = computeProductionReadinessScore([
      finding("security", "warning"),
    ]).score;
    const perf = computeProductionReadinessScore([
      finding("performance", "warning"),
    ]).score;
    expect(sec).toBeLessThan(perf);
  });

  it("caps a single high-severity (attention) finding at grade B", () => {
    const result = computeProductionReadinessScore([
      finding("contract", "attention"),
    ]);
    expect(result.score).toBeLessThanOrEqual(75);
    expect(result.grade).toBe("B");
  });

  it("caps two or more high-severity findings at grade C", () => {
    const result = computeProductionReadinessScore([
      finding("contract", "attention"),
      finding("security", "attention"),
    ]);
    expect(result.score).toBeLessThanOrEqual(55);
    expect(result.grade).toBe("C");
  });

  it("never grades A when a high-severity finding is present", () => {
    const result = computeProductionReadinessScore([
      finding("architecture", "attention"),
    ]);
    expect(result.grade).not.toBe("A");
  });

  it("routes unmapped categories into Deployment readiness", () => {
    const result = computeProductionReadinessScore([
      finding("error_handling", "attention"),
      finding("validation", "warning"),
    ]);
    const deployment = result.breakdown.find(
      (b) => b.category === "Deployment readiness",
    );
    expect(deployment?.findingCount).toBe(2);
    expect(deployment?.subscore).toBe(70);
  });

  it("floors a category subscore at 0 under heavy penalties", () => {
    const many = Array.from({ length: 5 }, () => finding("types", "critical"));
    const result = computeProductionReadinessScore(many);
    const types = result.breakdown.find((b) => b.category === "Type Safety");
    expect(types?.subscore).toBe(0);
  });

  it("is deterministic for the same findings", () => {
    const findings = [
      finding("security", "warning"),
      finding("architecture", "attention"),
      finding("types", "info"),
    ];
    const a = computeProductionReadinessScore(findings);
    const b = computeProductionReadinessScore([...findings].reverse());
    expect(a.score).toBe(b.score);
    expect(a.grade).toBe(b.grade);
  });

  it("exposes a per-category breakdown whose weights sum to 1", () => {
    const result = computeProductionReadinessScore([]);
    const total = result.breakdown.reduce((s, b) => s + b.weight, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(result.breakdown).toHaveLength(5);
  });
});
