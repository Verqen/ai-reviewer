import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("~/")) return join(SRC, `${specifier.slice(2)}.ts`);
  if (specifier.startsWith("."))
    return resolve(dirname(from), `${specifier}.ts`);
  return null;
}

function walk(entry: string): { bare: Set<string>; files: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
    );
    for (const statement of source.statements) {
      const specifierNode =
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (specifierNode === undefined || !ts.isStringLiteral(specifierNode))
        continue;
      const resolved = resolveSpecifier(file, specifierNode.text);
      if (resolved === null) bare.add(specifierNode.text);
      else queue.push(resolved);
    }
  }
  return { bare, files };
}

describe("@gkosach/core/rules entry", () => {
  it("imports no package and nothing outside src/domain", () => {
    const { bare, files } = walk(join(SRC, "rules.ts"));
    expect([...bare]).toEqual([]);
    const outside = [...files]
      .map((file) => relative(SRC, file))
      .filter((file) => file !== "rules.ts" && !file.startsWith("domain/"));
    expect(outside).toEqual([]);
  });
});
