import { describe, expect, it } from "vitest";

import type { ConsensusCandidate } from "~/domain/finding-consensus";
import {
  InvalidQuorumError,
  selectConsensusFindings,
} from "~/domain/finding-consensus";

function at(
  filePath: string,
  line: number,
  fingerprint: string,
  ruleId = "R-014",
): ConsensusCandidate {
  return { filePath, fingerprint, line, ruleId };
}

describe("selectConsensusFindings", () => {
  it("keeps a finding seen in two of three passes and drops one seen once", () => {
    const agreed = at("src/a.ts", 3, "f1");
    const lonely = at("src/b.ts", 7, "f2");

    const result = selectConsensusFindings(
      [[agreed], [at("src/a.ts", 3, "f1")], [lonely]],
      2,
    );

    expect(result).toEqual([agreed]);
    expect(result[0]).toBe(agreed);
  });

  it("treats the same place under another rule as a different finding", () => {
    const result = selectConsensusFindings(
      [
        [at("src/a.ts", 7, "f1", "R-021")],
        [at("src/a.ts", 7, "f1", "R-019")],
        [at("src/a.ts", 7, "f1", "R-022")],
      ],
      2,
    );

    expect(result).toEqual([]);
  });

  it("publishes a repeated line as many times as two passes agree", () => {
    const first = at("src/a.ts", 10, "f1");
    const second = at("src/a.ts", 40, "f1");

    const result = selectConsensusFindings(
      [[second, first], [at("src/a.ts", 12, "f1")], []],
      2,
    );

    expect(result).toEqual([first]);
    expect(result[0]).toBe(first);
  });

  it("orders the result by file, line and rule", () => {
    const later = at("src/b.ts", 1, "f2");
    const earlier = at("src/a.ts", 9, "f1");

    expect(
      selectConsensusFindings(
        [
          [later, earlier],
          [later, earlier],
        ],
        2,
      ),
    ).toEqual([earlier, later]);
  });

  it.each([0, 4, 1.5])("refuses a quorum of %s for three passes", (quorum) => {
    expect(() => selectConsensusFindings([[], [], []], quorum)).toThrow(
      InvalidQuorumError,
    );
  });
});
