import { describe, expect, it, vi } from "vitest";

import type {
  IDocProvider,
  LibraryInfo,
} from "~/domain/ports/doc-provider.port";
import type { ParsedFileDiff } from "~/review/diff-parser";
import { createMockLogger } from "~/test-utils/mock-logger";

import {
  fetchDocContextForFile,
  resolveLibrariesFromDiffs,
} from "./doc-context";

function buildDiff(content: string, path = "src/service.ts"): ParsedFileDiff {
  return {
    lines: [{ content, hunkHeader: "@@ -1 +1 @@", newLine: 1, type: "added" }],
    newPath: path,
    oldPath: path,
  };
}

function buildDocProvider(
  resolveLibraryFn = vi.fn().mockResolvedValue(null),
  queryDocsFn = vi.fn().mockResolvedValue(""),
): {
  provider: IDocProvider;
  resolveLibraryFn: ReturnType<typeof vi.fn>;
  queryDocsFn: ReturnType<typeof vi.fn>;
} {
  const provider: IDocProvider = {
    queryDocs: queryDocsFn,
    resolveLibrary: resolveLibraryFn,
  };
  return { provider, queryDocsFn, resolveLibraryFn };
}

describe("resolveLibrariesFromDiffs", () => {
  it("resolves external packages from diff content", async () => {
    const zodInfo: LibraryInfo = {
      description: "Schema validation",
      id: "/colinhacks/zod",
      name: "zod",
      snippetCount: 100,
    };

    const { provider, resolveLibraryFn } = buildDocProvider(
      vi.fn().mockResolvedValue(zodInfo),
    );

    const diff = buildDiff(`import { z } from "zod";`);
    const result = await resolveLibrariesFromDiffs(
      [diff],
      provider,
      createMockLogger(),
    );

    expect(result.byName.get("zod")).toEqual(zodInfo);
    expect(resolveLibraryFn).toHaveBeenCalledWith("zod", "API usage");
  });

  it("skips workspace packages declared via WORKSPACE_PACKAGE_PREFIXES env", async () => {
    const previous = process.env["WORKSPACE_PACKAGE_PREFIXES"];
    process.env["WORKSPACE_PACKAGE_PREFIXES"] = "@workspace/,@internal/";
    try {
      const { provider, resolveLibraryFn } = buildDocProvider();
      const diff = buildDiff(
        `import { thing } from "@workspace/utils";\nimport { other } from "@internal/api";`,
      );

      await resolveLibrariesFromDiffs([diff], provider, createMockLogger());

      expect(resolveLibraryFn).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env["WORKSPACE_PACKAGE_PREFIXES"];
      } else {
        process.env["WORKSPACE_PACKAGE_PREFIXES"] = previous;
      }
    }
  });

  it("skips relative imports", async () => {
    const { provider, resolveLibraryFn } = buildDocProvider();
    const diff = buildDiff(`import { foo } from "./local";`);

    await resolveLibrariesFromDiffs([diff], provider, createMockLogger());

    expect(resolveLibraryFn).not.toHaveBeenCalled();
  });

  it("respects max_libraries cap", async () => {
    const resolveLibraryFn = vi.fn().mockResolvedValue({
      description: "lib",
      id: "/some/lib",
      name: "lib",
      snippetCount: 1,
    });
    const { provider } = buildDocProvider(resolveLibraryFn);

    const imports = Array.from(
      { length: 15 },
      (_, i) => `import x${i} from "pkg-${i}";`,
    ).join("\n");
    const diff = buildDiff(imports);

    await resolveLibrariesFromDiffs([diff], provider, createMockLogger(), 5);

    expect(resolveLibraryFn).toHaveBeenCalledTimes(5);
  });

  it("continues gracefully when resolveLibrary throws", async () => {
    const resolveLibraryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValue({
        description: "Schema validation",
        id: "/colinhacks/zod",
        name: "zod",
        snippetCount: 100,
      });
    const { provider } = buildDocProvider(resolveLibraryFn);

    const diff = buildDiff(
      `import fastify from "fastify";\nimport { z } from "zod";`,
    );
    const result = await resolveLibrariesFromDiffs(
      [diff],
      provider,
      createMockLogger(),
    );

    expect(result.byName.size).toBe(1);
  });

  it("deduplicates packages across multiple diffs", async () => {
    const resolveLibraryFn = vi.fn().mockResolvedValue({
      description: "Schema validation",
      id: "/colinhacks/zod",
      name: "zod",
      snippetCount: 100,
    });
    const { provider } = buildDocProvider(resolveLibraryFn);

    const diffs = [
      buildDiff(`import { z } from "zod";`, "src/a.ts"),
      buildDiff(`import { z } from "zod";`, "src/b.ts"),
    ];

    await resolveLibrariesFromDiffs(diffs, provider, createMockLogger());

    expect(resolveLibraryFn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchDocContextForFile", () => {
  it("returns formatted doc context for imported packages", async () => {
    const zodInfo: LibraryInfo = {
      description: "Schema validation",
      id: "/colinhacks/zod",
      name: "zod",
      snippetCount: 100,
    };

    const { provider } = buildDocProvider(
      vi.fn().mockResolvedValue(null),
      vi.fn().mockResolvedValue("z.coerce converts values"),
    );

    const resolvedLibraries = { byName: new Map([["zod", zodInfo]]) };
    const diffContent = `import { z } from "zod";`;

    const result = await fetchDocContextForFile(
      diffContent,
      resolvedLibraries,
      provider,
      createMockLogger(),
      10000,
    );

    expect(result).toContain("--- Library Documentation ---");
    expect(result).toContain("[zod]");
    expect(result).toContain("z.coerce converts values");
  });

  it("returns empty string when no matching libraries", async () => {
    const { provider } = buildDocProvider();
    const resolvedLibraries = { byName: new Map<string, LibraryInfo>() };

    const result = await fetchDocContextForFile(
      `const x = 1;`,
      resolvedLibraries,
      provider,
      createMockLogger(),
      10000,
    );

    expect(result).toBe("");
  });

  it("returns empty string when queryDocs returns empty", async () => {
    const zodInfo: LibraryInfo = {
      description: "Schema validation",
      id: "/colinhacks/zod",
      name: "zod",
      snippetCount: 100,
    };

    const { provider } = buildDocProvider(
      vi.fn().mockResolvedValue(null),
      vi.fn().mockResolvedValue(""),
    );

    const resolvedLibraries = { byName: new Map([["zod", zodInfo]]) };

    const result = await fetchDocContextForFile(
      `import { z } from "zod";`,
      resolvedLibraries,
      provider,
      createMockLogger(),
      10000,
    );

    expect(result).toBe("");
  });

  it("continues gracefully when queryDocs throws", async () => {
    const zodInfo: LibraryInfo = {
      description: "Schema validation",
      id: "/colinhacks/zod",
      name: "zod",
      snippetCount: 100,
    };

    const { provider } = buildDocProvider(
      vi.fn().mockResolvedValue(null),
      vi.fn().mockRejectedValue(new Error("API error")),
    );

    const resolvedLibraries = { byName: new Map([["zod", zodInfo]]) };

    const result = await fetchDocContextForFile(
      `import { z } from "zod";`,
      resolvedLibraries,
      provider,
      createMockLogger(),
      10000,
    );

    expect(result).toBe("");
  });
});
