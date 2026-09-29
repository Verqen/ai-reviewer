import { describe, expect, it } from "vitest";

import type { FingerprintedFinding } from "~/domain/finding-comparison";
import { compareFindings } from "~/domain/finding-comparison";

function at(
  filePath: string,
  line: number,
  fingerprint: string,
  ruleId = "R-014",
): FingerprintedFinding {
  return { filePath, fingerprint, line, ruleId };
}

const ALL_RULES: ReadonlySet<string> = new Set(["R-014", "R-019"]);

function compare(
  current: FingerprintedFinding[],
  baseline: FingerprintedFinding[],
  currentPaths: string[],
  overrides: {
    comparableRuleIds?: ReadonlySet<string>;
    unreviewedPaths?: ReadonlySet<string>;
  } = {},
): ReturnType<typeof compareFindings> {
  return compareFindings({
    baseline,
    comparableRuleIds: overrides.comparableRuleIds ?? ALL_RULES,
    current,
    currentPaths: new Set(currentPaths),
    unreviewedPaths: overrides.unreviewedPaths ?? new Set(),
  });
}

describe("compareFindings", () => {
  it("keeps a finding persisting when lines above it shift", () => {
    const before = at("src/a.ts", 10, "f1");
    const after = at("src/a.ts", 20, "f1");

    const result = compare([after], [before], ["src/a.ts"]);

    expect(result.persisting).toEqual([
      { baseline: before, current: after, moved: false },
    ]);
    expect(result.new).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("reports an edited anchored line as resolved plus new", () => {
    const before = at("src/a.ts", 10, "f1");
    const after = at("src/a.ts", 30, "f2");

    const result = compare([after], [before], ["src/a.ts"]);

    expect(result.new).toEqual([after]);
    expect(result.resolved).toEqual([{ fileRemoved: false, finding: before }]);
    expect(result.persisting).toEqual([]);
  });

  it("marks a finding of a deleted file as resolved with the file removed", () => {
    const before = at("src/gone.ts", 4, "f1");

    const result = compare([], [before], ["src/a.ts"]);

    expect(result.resolved).toEqual([{ fileRemoved: true, finding: before }]);
  });

  it("matches a finding of a renamed file as moved when the match is unique", () => {
    const before = at("src/old.ts", 4, "f1");
    const after = at("src/new.ts", 4, "f1");

    const result = compare([after], [before], ["src/new.ts"]);

    expect(result.persisting).toEqual([
      { baseline: before, current: after, moved: true },
    ]);
    expect(result.new).toEqual([]);
    expect(result.resolved).toEqual([]);
  });

  it("counts two identical lines as a multiset when one of them is removed", () => {
    const first = at("src/a.ts", 10, "f1");
    const second = at("src/a.ts", 40, "f1");
    const remaining = at("src/a.ts", 12, "f1");

    const result = compare([remaining], [first, second], ["src/a.ts"]);

    expect(result.persisting).toHaveLength(1);
    expect(result.resolved).toHaveLength(1);
    expect(result.new).toEqual([]);
  });

  it("reports an ambiguous rename as new plus resolved", () => {
    const oldOne = at("src/old-1.ts", 4, "f1");
    const oldTwo = at("src/old-2.ts", 4, "f1");
    const renamed = at("src/new.ts", 4, "f1");

    const result = compare([renamed], [oldOne, oldTwo], ["src/new.ts"]);

    expect(result.persisting).toEqual([]);
    expect(result.new).toEqual([renamed]);
    expect(result.resolved).toEqual([
      { fileRemoved: true, finding: oldOne },
      { fileRemoved: true, finding: oldTwo },
    ]);
  });

  it("does not compare findings of a rule outside both catalog versions", () => {
    const current = at("src/a.ts", 1, "f1", "R-019");
    const baseline = at("src/a.ts", 5, "f2", "R-019");

    const result = compare([current], [baseline], ["src/a.ts"], {
      comparableRuleIds: new Set(["R-014"]),
    });

    expect(result).toEqual({
      new: [],
      notComparable: 2,
      persisting: [],
      resolved: [],
    });
  });

  it("does not compare baseline findings in files this run did not review", () => {
    const skipped = at("src/big.ts", 3, "f1");

    const result = compare([], [skipped], ["src/big.ts"], {
      unreviewedPaths: new Set(["src/big.ts"]),
    });

    expect(result.resolved).toEqual([]);
    expect(result.notComparable).toBe(1);
  });

  it("does not compare current findings in files this run did not review", () => {
    const baseline = at("src/big.ts", 3, "f1");
    const current = at("src/big.ts", 3, "f1");

    const result = compare([current], [baseline], ["src/big.ts"], {
      unreviewedPaths: new Set(["src/big.ts"]),
    });

    expect(result).toEqual({
      new: [],
      notComparable: 2,
      persisting: [],
      resolved: [],
    });
  });

  it("orders findings by code point rather than locale", () => {
    const lower = at("src/a.ts", 1, "f1");
    const upper = at("src/B.ts", 1, "f2");

    const result = compare([lower, upper], [], ["src/a.ts", "src/B.ts"]);

    expect(result.new).toEqual([upper, lower]);
  });

  it("partitions every comparable finding exactly once", () => {
    let seed = 7;
    function next(limit: number): number {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    }
    function randomFinding(): FingerprintedFinding {
      return at(
        `src/${String(next(4))}.ts`,
        next(50) + 1,
        `f${String(next(5))}`,
        next(3) === 0 ? "R-019" : "R-014",
      );
    }
    for (let round = 0; round < 200; round++) {
      const current = Array.from({ length: next(8) }, randomFinding);
      const baseline = Array.from({ length: next(8) }, randomFinding);
      const comparable = new Set(["R-014"]);
      const unreviewed = new Set([`src/${String(next(4))}.ts`]);
      const currentPaths = [0, 1, 2]
        .filter(() => next(2) === 0)
        .map((index) => `src/${String(index)}.ts`);

      const result = compare(current, baseline, currentPaths, {
        comparableRuleIds: comparable,
        unreviewedPaths: unreviewed,
      });

      const currentComparable = current.filter(
        (finding) =>
          comparable.has(finding.ruleId) && !unreviewed.has(finding.filePath),
      ).length;
      const baselineComparable = baseline.filter(
        (finding) =>
          comparable.has(finding.ruleId) && !unreviewed.has(finding.filePath),
      ).length;
      expect(result.new.length + result.persisting.length).toBe(
        currentComparable,
      );
      expect(result.persisting.length + result.resolved.length).toBe(
        baselineComparable,
      );
      expect(result.notComparable).toBe(
        current.length +
          baseline.length -
          currentComparable -
          baselineComparable,
      );
    }
  });
});
