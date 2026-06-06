import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

import {
  buildArchitectureSnapshot,
  type ArchitectureSnapshotLimits,
} from "./architecture-snapshot";

const DEFAULT_LIMITS: ArchitectureSnapshotLimits = {
  maxFileChars: 100,
  maxListFiles: 3,
  maxTotalChars: 1000,
};

function createMockLogger(): FastifyBaseLogger {
  return {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    level: "info",
    silent: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function createMockSnapshotRepo(
  overrides: Partial<ISnapshotRepository> = {},
): ISnapshotRepository {
  return {
    copySnapshotEntries: vi.fn(),
    deleteCommit: vi.fn(),
    deleteOldSnapshotsBefore: vi.fn(),
    getBaselineState: vi.fn(),
    getFileContent: vi.fn().mockResolvedValue(null),
    listFiles: vi.fn().mockResolvedValue([]),
    listPackageRootsFromSnapshot: vi.fn().mockResolvedValue({
      hasTopLevelSrcTree: false,
      packageRoots: [],
      packageRootsUsingSrc: [],
    }),
    searchContent: vi.fn(),
    setBaselineState: vi.fn(),
    storeBlobs: vi.fn(),
    storeSnapshot: vi.fn(),
    ...overrides,
  };
}

describe("buildArchitectureSnapshot", () => {
  it("returns undefined when no files found", async () => {
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: DEFAULT_LIMITS,
      logger: createMockLogger(),
      projectId: 1,
      snapshotRepo: createMockSnapshotRepo(),
    });
    expect(result).toBeUndefined();
  });

  it("assembles package.json, src structure, and CLAUDE.md", async () => {
    const repo = createMockSnapshotRepo({
      getFileContent: vi.fn(
        (_projectId: number, _commitSha: string, path: string) => {
          if (path === "package.json") return Promise.resolve('{"name":"x"}');
          if (path === "CLAUDE.md") return Promise.resolve("# Project");
          return Promise.resolve(null);
        },
      ),
      listFiles: vi.fn().mockResolvedValue(["src/a.ts", "src/b.ts"]),
    });
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: DEFAULT_LIMITS,
      logger: createMockLogger(),
      projectId: 1,
      snapshotRepo: repo,
    });
    expect(result).toContain("<package_json>");
    expect(result).toContain('{"name":"x"}');
    expect(result).toContain("<src_structure>");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("<claude_md>");
    expect(result).toContain("# Project");
  });

  it("clamps src files list to maxListFiles and warns", async () => {
    const logger = createMockLogger();
    const repo = createMockSnapshotRepo({
      listFiles: vi.fn().mockResolvedValue(["s/1", "s/2", "s/3", "s/4", "s/5"]),
    });
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: { ...DEFAULT_LIMITS, maxListFiles: 2 },
      logger,
      projectId: 1,
      snapshotRepo: repo,
    });
    expect(result).toContain("s/1");
    expect(result).toContain("s/2");
    expect(result).not.toContain("s/3");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ truncatedList: true }),
      expect.any(String),
    );
  });

  it("clamps per-file content to maxFileChars", async () => {
    const big = "x".repeat(500);
    const repo = createMockSnapshotRepo({
      getFileContent: vi.fn(
        (_projectId: number, _commitSha: string, path: string) =>
          Promise.resolve(path === "package.json" ? big : null),
      ),
    });
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: { ...DEFAULT_LIMITS, maxFileChars: 50 },
      logger: createMockLogger(),
      projectId: 1,
      snapshotRepo: repo,
    });
    const match = /<package_json>\n([\s\S]*?)\n<\/package_json>/.exec(
      result ?? "",
    );
    expect(match?.[1]).toHaveLength(50);
  });

  it("clamps assembled output to maxTotalChars with truncated marker", async () => {
    const repo = createMockSnapshotRepo({
      getFileContent: vi.fn(
        (_projectId: number, _commitSha: string, path: string) =>
          Promise.resolve(path === "CLAUDE.md" ? "y".repeat(500) : null),
      ),
    });
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: { maxFileChars: 1000, maxListFiles: 10, maxTotalChars: 80 },
      logger: createMockLogger(),
      projectId: 1,
      snapshotRepo: repo,
    });
    expect(result?.endsWith("<!-- truncated -->")).toBe(true);
    expect(result?.length).toBeLessThanOrEqual(
      80 + "\n<!-- truncated -->".length,
    );
  });

  it("returns undefined and warns on error", async () => {
    const logger = createMockLogger();
    const repo = createMockSnapshotRepo({
      getFileContent: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const result = await buildArchitectureSnapshot({
      commitSha: "sha",
      limits: DEFAULT_LIMITS,
      logger,
      projectId: 1,
      snapshotRepo: repo,
    });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as Error }),
      expect.stringContaining("Failed to build architecture snapshot"),
    );
  });
});
