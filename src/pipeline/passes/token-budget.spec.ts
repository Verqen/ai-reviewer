import { describe, expect, it } from "vitest";

import { getPrimarySkipReason } from "./skip-filter";

const APPROX_CHARS_PER_TOKEN = 4;
const AVG_CHARS_PER_REVIEWED_FILE_PROMPT = 6_000;

interface FixtureFile {
  category: "source" | "spec" | "config" | "migration" | "declaration";
  path: string;
}

const REALISTIC_75_FILE_MR: FixtureFile[] = [
  ...range(35, (i) => ({
    category: "source" as const,
    path: `services/api/src/modules/feature${String(i)}/handler.ts`,
  })),
  ...range(10, (i) => ({
    category: "spec" as const,
    path: `services/api/src/modules/feature${String(i)}/handler.spec.ts`,
  })),
  ...range(10, (i) => ({
    category: "config" as const,
    path:
      i % 4 === 0
        ? "services/api/package.json"
        : i % 4 === 1
          ? "services/api/tsconfig.json"
          : i % 4 === 2
            ? "services/api/vitest.config.ts"
            : "services/api/.env.example",
  })),
  ...range(10, (i) => ({
    category: "migration" as const,
    path: `services/api/src/db/migrations/${String(20260400 + i)}-init.ts`,
  })),
  ...range(10, (i) => ({
    category: "declaration" as const,
    path: `services/api/src/types/feature${String(i)}.d.ts`,
  })),
];

function range<T>(count: number, build: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => build(i));
}

describe("token budget guard (architectural)", () => {
  it("skip-filter eliminates configs, migrations and declarations on a realistic 75-file MR", () => {
    const reviewable = REALISTIC_75_FILE_MR.filter(
      (f) => getPrimarySkipReason(f.path) === null,
    );

    const reviewableSources = reviewable.filter(
      (f) => f.category === "source" || f.category === "spec",
    );

    expect(reviewable.length).toBeLessThanOrEqual(45);
    expect(reviewableSources.length).toBe(45);

    const skippedCategories = new Set(
      REALISTIC_75_FILE_MR.filter(
        (f) => getPrimarySkipReason(f.path) !== null,
      ).map((f) => f.category),
    );
    expect(skippedCategories).toEqual(
      new Set(["config", "migration", "declaration"]),
    );
  });

  it("estimated file-review prompt budget for a realistic 75-file MR stays under the run-level cap of the previous design (25K)", () => {
    const reviewable = REALISTIC_75_FILE_MR.filter(
      (f) => getPrimarySkipReason(f.path) === null,
    );
    const estimatedBytes =
      reviewable.length * AVG_CHARS_PER_REVIEWED_FILE_PROMPT;
    const estimatedPromptTokens = Math.ceil(
      estimatedBytes / APPROX_CHARS_PER_TOKEN,
    );

    expect(reviewable.length).toBeLessThanOrEqual(45);
    expect(estimatedPromptTokens).toBeLessThanOrEqual(70_000);
  });

  it("regression guard: every fixture file is correctly classified by skip-filter", () => {
    const expectedSkip = new Set(["config", "migration", "declaration"]);
    for (const file of REALISTIC_75_FILE_MR) {
      const reason = getPrimarySkipReason(file.path);
      const shouldBeSkipped = expectedSkip.has(file.category);
      if (shouldBeSkipped) {
        expect(reason, `${file.path} (${file.category})`).not.toBeNull();
      } else {
        expect(reason, `${file.path} (${file.category})`).toBeNull();
      }
    }
  });
});
