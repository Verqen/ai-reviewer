import { describe, expect, it } from "vitest";

import {
  matchFilePathGlob,
  matchFilePathGlobWithLiteralPrefix,
  normalizeFilePathForGlob,
} from "./match-file-path-glob";

describe("normalizeFilePathForGlob", () => {
  it("replaces backslashes with forward slashes", () => {
    const actualResult = normalizeFilePathForGlob("a\\b\\c.ts");
    expect(actualResult).toBe("a/b/c.ts");
  });
});

describe("matchFilePathGlob", () => {
  it("matches ** across directories", () => {
    expect(matchFilePathGlob("src/foo/bar.ts", "src/**/*.ts")).toBe(true);
  });

  it("does not match when a path segment is longer than single-? wildcard", () => {
    expect(matchFilePathGlob("src/ab/b.ts", "src/?/b.ts")).toBe(false);
  });

  it("matches ? within one path segment", () => {
    expect(matchFilePathGlob("src/x/b.ts", "src/?/b.ts")).toBe(true);
  });
});

describe("matchFilePathGlobWithLiteralPrefix", () => {
  it("uses prefix semantics when the pattern has no glob magic", () => {
    expect(matchFilePathGlobWithLiteralPrefix("src/app/file.ts", "src/")).toBe(
      true
    );
    expect(matchFilePathGlobWithLiteralPrefix("lib/x.ts", "src/")).toBe(false);
  });

  it("matches glob patterns when the pattern has magic", () => {
    expect(
      matchFilePathGlobWithLiteralPrefix("pkg/src/a.ts", "**/src/*.ts")
    ).toBe(true);
  });
});
