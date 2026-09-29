import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildFindingThreadReply,
  buildMentionReply,
} from "~/domain/rule-catalog/thread-reply";
import { getRuleCatalog } from "~/domain/rule-catalog/rule-catalog";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const MODEL_ACCESS_PATTERN = /llm|openrouter|ollama|anthropic|openai/i;

function resolveModule(specifier: string, importer: string): string | null {
  const base = specifier.startsWith("~/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(importer), specifier)
      : null;
  if (base === null) return null;
  return (
    [`${base}.ts`, join(base, "index.ts")].find((candidate) =>
      existsSync(candidate),
    ) ?? null
  );
}

function externalSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)]
    .map((match) => match[1] ?? "")
    .filter(
      (specifier) => !specifier.startsWith("~/") && !specifier.startsWith("."),
    );
}

function moduleGraph(entry: string): {
  externals: string[];
  modules: string[];
} {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(current, "utf8");
    externalSpecifiers(source).forEach((specifier) => externals.add(specifier));
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveModule(match[1] ?? "", current);
      if (resolved !== null) pending.push(resolved);
    }
  }
  return {
    externals: [...externals],
    modules: [...seen].map((file) => relative(SRC, file)),
  };
}

describe("import specifier detection", () => {
  it("matches static, side-effect, dynamic and require forms", () => {
    const source = [
      'import { a } from "static-mod";',
      'import "side-effect-mod";',
      'const b = await import("dynamic-mod");',
      "const c = require('require-mod');",
    ].join("\n");
    expect(
      [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]),
    ).toEqual(["static-mod", "side-effect-mod", "dynamic-mod", "require-mod"]);
  });
});

describe("thread replies come only from fixed catalog text", () => {
  it("builds replies from a module graph that reaches no model client", () => {
    const graph = moduleGraph(join(SRC, "domain/rule-catalog/thread-reply.ts"));
    expect(graph.modules).toContain("domain/rule-catalog/thread-reply.ts");
    expect(graph.modules).toContain("domain/rule-catalog/rule-catalog.ts");
    expect(graph.modules.filter((m) => MODEL_ACCESS_PATTERN.test(m))).toEqual(
      [],
    );
    expect(graph.externals.filter((e) => MODEL_ACCESS_PATTERN.test(e))).toEqual(
      [],
    );
    expect(
      graph.modules.filter((m) => m.startsWith("infrastructure/")),
    ).toEqual([]);
  });

  it("posts replies through a module that reaches no model client", () => {
    const graph = moduleGraph(join(SRC, "review/github-thread-reply.ts"));
    expect(graph.modules).toContain("domain/rule-catalog/thread-reply.ts");
    expect(graph.modules.filter((m) => MODEL_ACCESS_PATTERN.test(m))).toEqual(
      [],
    );
    expect(graph.externals.filter((e) => MODEL_ACCESS_PATTERN.test(e))).toEqual(
      [],
    );
  });

  it("returns exactly the fixed template for every catalog rule", () => {
    const rules = getRuleCatalog().rules;
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(
        buildFindingThreadReply(rule.id, "https://rules.example.com/rules"),
      ).toBe(
        `AI Reviewer is an automated check against a published rule catalog and does not answer questions about findings. Rule ${rule.id}: ${rule.condition} https://rules.example.com/rules#${rule.id}`,
      );
    }
  });

  it("returns exactly the fixed template for a mention", () => {
    expect(buildMentionReply("https://rules.example.com/rules")).toBe(
      "AI Reviewer is an automated check against a published rule catalog and does not answer questions. Rule catalog: https://rules.example.com/rules",
    );
  });
});
