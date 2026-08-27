import { describe, expect, it } from "vitest";

import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";

import { ReviewHistoryService } from "./review-history.service";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: "bug",
    comment: "test finding",
    confidence: 0.9,
    filePath: "src/foo.ts",
    id: "finding-1",
    lineNumber: 10,
    lineType: "added",
    model: "test",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
    ...overrides,
  };
}

function makeFindingRepo(findings: ReviewFinding[]): IReviewFindingRepository {
  return {
    createMany: () => Promise.resolve([]),
    existsByHostDiscussionId: () => Promise.resolve(false),
    findByProjectAndMr: () => Promise.resolve(findings),
    findByRunId: () => Promise.resolve(findings),
    updateResolution: () => Promise.resolve(),
    updateResolutionMany: () => Promise.resolve(),
  };
}

describe("ReviewHistoryService", () => {
  describe("loadPriorFindings", () => {
    it("groups findings by resolution", async () => {
      const findings = [
        makeFinding({ id: "f1", resolution: "pending" }),
        makeFinding({ id: "f2", resolution: "addressed" }),
        makeFinding({ id: "f3", resolution: "dismissed" }),
        makeFinding({ id: "f4", resolution: "wont_fix" }),
        makeFinding({ id: "f5", resolution: "pending" }),
      ];

      const service = new ReviewHistoryService(makeFindingRepo(findings));
      const result = await service.loadPriorFindings(1, 42);

      expect(result.pending).toHaveLength(2);
      expect(result.addressed).toHaveLength(1);
      expect(result.dismissed).toHaveLength(2);

      expect(result.pending.map((f) => f.id)).toEqual(["f1", "f5"]);
      expect(result.addressed[0]?.id).toBe("f2");
      expect(result.dismissed.map((f) => f.id)).toEqual(["f3", "f4"]);
    });

    it("returns empty arrays when no findings exist", async () => {
      const service = new ReviewHistoryService(makeFindingRepo([]));
      const result = await service.loadPriorFindings(1, 42);

      expect(result.pending).toHaveLength(0);
      expect(result.addressed).toHaveLength(0);
      expect(result.dismissed).toHaveLength(0);
    });

    it("places wont_fix in dismissed group", async () => {
      const findings = [
        makeFinding({ id: "f1", resolution: "wont_fix" }),
        makeFinding({ id: "f2", resolution: "dismissed" }),
      ];

      const service = new ReviewHistoryService(makeFindingRepo(findings));
      const result = await service.loadPriorFindings(1, 42);

      expect(result.dismissed).toHaveLength(2);
      expect(result.pending).toHaveLength(0);
      expect(result.addressed).toHaveLength(0);
    });
  });

  describe("getPendingFindings", () => {
    it("returns only pending findings", async () => {
      const findings = [
        makeFinding({ id: "f1", resolution: "pending" }),
        makeFinding({ id: "f2", resolution: "addressed" }),
        makeFinding({ id: "f3", resolution: "pending" }),
        makeFinding({ id: "f4", resolution: "dismissed" }),
      ];

      const service = new ReviewHistoryService(makeFindingRepo(findings));
      const result = await service.getPendingFindings(1, 42);

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.id)).toEqual(["f1", "f3"]);
    });

    it("returns empty when all findings are resolved", async () => {
      const findings = [
        makeFinding({ id: "f1", resolution: "addressed" }),
        makeFinding({ id: "f2", resolution: "dismissed" }),
      ];

      const service = new ReviewHistoryService(makeFindingRepo(findings));
      const result = await service.getPendingFindings(1, 42);

      expect(result).toHaveLength(0);
    });
  });
});
