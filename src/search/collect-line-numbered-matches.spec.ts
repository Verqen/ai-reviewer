import { describe, expect, it } from "vitest";

import { collectLineNumberedMatches } from "./collect-line-numbered-matches";

describe("collectLineNumberedMatches", () => {
  it("includes 1-based line prefix for a single hit", () => {
    const inputText = "alpha\nbeta foo\n";

    const actualResult = collectLineNumberedMatches(inputText, "foo");

    expect(actualResult).toEqual(["2:beta foo"]);
  });

  it("returns multiple prefixed lines top-to-bottom", () => {
    const inputText = "x foo\nno\n foo tail\n";

    const actualResult = collectLineNumberedMatches(inputText, "foo");

    expect(actualResult).toEqual(["1:x foo", "3: foo tail"]);
  });

  it("handles several lines separated by newline", () => {
    const inputText = `first
second BAR
third
fourth BAR
`;

    const actualResult = collectLineNumberedMatches(inputText, "BAR");

    expect(actualResult).toEqual(["2:second BAR", "4:fourth BAR"]);
  });

  it("treats empty pattern like includes: every line matches", () => {
    const inputText = "a\nbb";

    const actualResult = collectLineNumberedMatches(inputText, "");

    expect(actualResult).toEqual(["1:a", "2:bb"]);
  });
});
