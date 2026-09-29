import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OPENROUTER_REVIEW_MODEL } from "~/config/models";
import { CostBudget } from "~/domain/cost-budget";
import type { ReviewFinding } from "~/domain/types/review.types";
import { DismissedPatternRepository } from "~/infrastructure/database/repositories/dismissed-pattern.repository";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewFindingRepository } from "~/test-utils/mock-review-finding-repository";
import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { ReviewLearningService } from "./review-learning.service";

let testDb: TestDatabase;
let repo: DismissedPatternRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new DismissedPatternRepository(testDb.db);
}, 300_000);

beforeEach(async () => {
  await testDb.wipe();
});

afterAll(async () => {
  await testDb.cleanup();
});

function buildFinding(): ReviewFinding {
  return {
    category: "correctness",
    comment: "null checks on optional input are missing",
    confidence: 0.8,
    filePath: "src/foo.ts",
    id: "finding-1",
    lineNumber: 10,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    ruleId: "R-014",
    severity: "attention",
  };
}

function createService(): ReviewLearningService {
  return new ReviewLearningService(
    repo,
    createMockReviewFindingRepository(),
    createMockLlmClient({ defaultContent: "null checks dismissed" }),
    createMockLogger(),
    OPENROUTER_REVIEW_MODEL,
  );
}

async function dismiss(service: ReviewLearningService): Promise<void> {
  await service.learnFromReply({
    authorUsername: "dev-user",
    classifiedIntent: { intent: "false_positive", reason: "by design" },
    costBudget: new CostBudget(undefined),
    devReply: "intentional",
    finding: buildFinding(),
    mrIid: 1,
    projectId: 1,
  });
}

describe("ReviewLearningService with the dismissed pattern repository", () => {
  it("never increments a legacy pattern without a rule id or a pattern of another rule", async () => {
    const legacy = await repo.create({
      category: "correctness",
      patternDescription: "null checks on optional input are missing",
      projectId: 1,
      ruleId: "R-014",
      severity: "attention",
    });
    await sql`UPDATE dismissed_pattern SET rule_id = NULL WHERE id = ${legacy.id}`.execute(
      testDb.db,
    );
    const otherRule = await repo.create({
      category: "correctness",
      patternDescription: "null checks on optional input are missing",
      projectId: 1,
      ruleId: "R-013",
      severity: "attention",
    });

    await dismiss(createService());

    const patterns = await repo.findByProject(1);
    const byId = new Map(patterns.map((pattern) => [pattern.id, pattern]));
    expect(byId.get(legacy.id)?.occurrenceCount).toBe(1);
    expect(byId.get(otherRule.id)?.occurrenceCount).toBe(1);
    const created = patterns.filter((pattern) => pattern.ruleId === "R-014");
    expect(created).toHaveLength(1);
    expect(created[0]?.occurrenceCount).toBe(1);
  });

  it("increments the pattern of the same rule", async () => {
    const sameRule = await repo.create({
      category: "correctness",
      patternDescription: "unrelated wording",
      projectId: 1,
      ruleId: "R-014",
      severity: "attention",
    });

    await dismiss(createService());

    const patterns = await repo.findByProject(1);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.id).toBe(sameRule.id);
    expect(patterns[0]?.occurrenceCount).toBe(2);
  });
});
