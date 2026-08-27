import { describe, expect, it } from "vitest";

import { booleanEnv } from "~/config/boolean-env";

describe("booleanEnv", () => {
  it("parses the two accepted spellings", () => {
    expect(booleanEnv(false).parse("true")).toBe(true);
    expect(booleanEnv(true).parse("false")).toBe(false);
  });

  it("falls back to the declared default when the variable is unset", () => {
    expect(booleanEnv(true).parse(undefined)).toBe(true);
    expect(booleanEnv(false).parse(undefined)).toBe(false);
  });

  it.each([
    "0",
    "1",
    "no",
    "yes",
    "off",
    "on",
    "disabled",
    "TRUE",
    "False",
    "",
  ])("rejects %o instead of guessing", (value) => {
    expect(booleanEnv(true).safeParse(value).success).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(booleanEnv(true).safeParse(null).success).toBe(false);
    expect(booleanEnv(true).safeParse(1).success).toBe(false);
  });
});
