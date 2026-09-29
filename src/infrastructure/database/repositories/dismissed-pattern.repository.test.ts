import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { DismissedPatternRepository } from "./dismissed-pattern.repository";

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

describe("DismissedPatternRepository", () => {
  it("stores a rule id and finds patterns by project", async () => {
    await repo.create({
      category: "correctness",
      filePathGlob: "src/legacy/**",
      patternDescription: "legacy null checks",
      projectId: 1,
      ruleId: "R-014",
      sampleComment: undefined,
      sampleReply: "known",
      severity: "attention",
    });
    const [pattern] = await repo.findByProject(1);
    expect(pattern?.ruleId).toBe("R-014");
  });

  it("refuses a new pattern without a rule id", async () => {
    await expect(
      repo.create({
        category: "correctness",
        patternDescription: "legacy null checks",
        projectId: 1,
        ruleId: undefined,
        severity: "attention",
      }),
    ).rejects.toThrow(/dismissed_pattern_rule_id_required/);
  });
});
