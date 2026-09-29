import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!path.endsWith(".ts")) return [];
    if (/\.(spec|test|e2e\.test)\.ts$/.test(path)) return [];
    if (path.includes("/migrations/")) return [];
    return [path];
  });
}

const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: "suggestion", pattern: /\bsuggestion/i },
  { name: "score", pattern: /\bscore\b/i },
  { name: "grade", pattern: /\bgrade\b/i },
  { name: "suggestion fence", pattern: /```suggestion/ },
  { name: "production readiness", pattern: /production-readiness/i },
];

describe("engine output carries no code fixes and no grades", () => {
  it("has none of the forbidden terms in production source", () => {
    const hits = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          FORBIDDEN.filter(({ pattern }) => pattern.test(line)).map(
            ({ name }) => `${relative(SRC, file)}:${String(index + 1)} ${name}`,
          ),
        ),
    );
    expect(hits).toEqual([]);
  });
});
