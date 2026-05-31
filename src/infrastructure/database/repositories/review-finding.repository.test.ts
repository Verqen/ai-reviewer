import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreateReviewFindingInput } from "~/domain/ports/review-finding.repository.port";
import type { ReviewRun } from "~/domain/types/review.types";
import type { TestDatabase } from "~/test-utils/test-database";
import { createTestDatabase } from "~/test-utils/test-database";

import { ReviewFindingRepository } from "./review-finding.repository";
import { ReviewRunRepository } from "./review-run.repository";

let testDb: TestDatabase;
let findingRepo: ReviewFindingRepository;
let runRepo: ReviewRunRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  findingRepo = new ReviewFindingRepository(testDb.db);
  runRepo = new ReviewRunRepository(testDb.db);
}, 300_000);

beforeEach(async () => {
  await testDb.wipe();
});

afterAll(async () => {
  await testDb.cleanup();
});

async function createTestRun(): Promise<ReviewRun> {
  return runRepo.create({
    baseCommitSha: "base-sha",
    headCommitSha: "head-sha",
    isIncremental: false,
    mrIid: 1,
    projectId: 1,
    triggerType: "mr_open",
  });
}

function makeFindingInput(
  runId: string,
  overrides: Partial<CreateReviewFindingInput> = {},
): CreateReviewFindingInput {
  return {
    category: "bug",
    comment: "Something is wrong here",
    confidence: 0.9,
    filePath: "src/index.ts",
    lineNumber: 10,
    lineType: "added",
    model: "claude",
    passName: "single-pass",
    reviewRunId: runId,
    severity: "warning",
    ...overrides,
  };
}

describe("ReviewFindingRepository", () => {
  it("createMany returns persisted findings", async () => {
    const run = await createTestRun();
    const findings = await findingRepo.createMany([
      makeFindingInput(run.id),
      makeFindingInput(run.id, { severity: "attention" }),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.id).toBeDefined();
    expect(findings[1]?.severity).toBe("attention");
  });

  it("createMany with empty array returns empty array", async () => {
    const result = await findingRepo.createMany([]);
    expect(result).toHaveLength(0);
  });

  it("findByRunId returns findings for run", async () => {
    const run = await createTestRun();
    await findingRepo.createMany([
      makeFindingInput(run.id),
      makeFindingInput(run.id),
    ]);
    const found = await findingRepo.findByRunId(run.id);
    expect(found).toHaveLength(2);
    expect(found[0]?.reviewRunId).toBe(run.id);
  });

  it("findByProjectAndMr returns findings across runs for MR", async () => {
    const run = await createTestRun();
    await findingRepo.createMany([makeFindingInput(run.id)]);
    const found = await findingRepo.findByProjectAndMr(1, 1);
    expect(found).toHaveLength(1);
  });

  it("persists line_excerpt and hunk_header", async () => {
    const run = await createTestRun();
    await findingRepo.createMany([
      makeFindingInput(run.id, {
        hunkHeader: "@@ -1,2 +1,3 @@",
        lineExcerpt: "const x = 1;",
      }),
    ]);
    const found = await findingRepo.findByRunId(run.id);
    expect(found[0]?.lineExcerpt).toBe("const x = 1;");
    expect(found[0]?.hunkHeader).toBe("@@ -1,2 +1,3 @@");
  });

  it("persists hostDiscussionId and hostNoteId", async () => {
    const run = await createTestRun();
    await findingRepo.createMany([
      makeFindingInput(run.id, {
        hostDiscussionId: "disc-abc",
        hostNoteId: "note-123",
      }),
    ]);
    const found = await findingRepo.findByRunId(run.id);
    expect(found[0]?.hostDiscussionId).toBe("disc-abc");
    expect(found[0]?.hostNoteId).toBe("note-123");
  });

  it("updateResolution changes resolution and sets resolved_at", async () => {
    const run = await createTestRun();
    const [finding] = await findingRepo.createMany([makeFindingInput(run.id)]);
    await findingRepo.updateResolution(
      finding!.id,
      "dismissed",
      "alice",
      "False positive",
    );
    const found = await findingRepo.findByRunId(run.id);
    expect(found[0]?.resolution).toBe("dismissed");
    expect(found[0]?.resolvedBy).toBe("alice");
    expect(found[0]?.dismissReason).toBe("False positive");
    expect(found[0]?.resolvedAt).toBeDefined();
  });

  it("cascade deletes findings when run is deleted", async () => {
    const run = await createTestRun();
    await findingRepo.createMany([makeFindingInput(run.id)]);

    await testDb.db.deleteFrom("review_run").where("id", "=", run.id).execute();

    const remaining = await findingRepo.findByRunId(run.id);
    expect(remaining).toHaveLength(0);
  });
});
