import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fingerprintFinding,
  normalizeLine,
} from "~/domain/finding-fingerprint";

describe("normalizeLine", () => {
  it("trims the ends and collapses inner whitespace runs to one space", () => {
    expect(normalizeLine("\t  const  a =\t\tb;  ")).toBe("const a = b;");
  });
});

describe("fingerprintFinding", () => {
  it("is 32 lowercase hex characters", () => {
    expect(fingerprintFinding(42, "R-014", "return user.name;")).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });

  it("hashes the v1 scheme of repository, rule and normalized line", () => {
    const expected = createHash("sha256")
      .update("v1\n42\nR-014\nreturn user.name;")
      .digest("hex")
      .slice(0, 32);

    expect(fingerprintFinding(42, "R-014", "   return  user.name;")).toBe(
      expected,
    );
  });

  it("survives re-indentation of the anchored line", () => {
    expect(fingerprintFinding(42, "R-014", "\t\treturn   user.name;")).toBe(
      fingerprintFinding(42, "R-014", "return user.name;"),
    );
  });

  it("differs between repositories, rules and line texts", () => {
    const base = fingerprintFinding(42, "R-014", "return user.name;");

    expect(fingerprintFinding(43, "R-014", "return user.name;")).not.toBe(base);
    expect(fingerprintFinding(42, "R-019", "return user.name;")).not.toBe(base);
    expect(fingerprintFinding(42, "R-014", "return user?.name;")).not.toBe(
      base,
    );
  });
});
