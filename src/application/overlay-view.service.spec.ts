import { describe, expect, it, vi } from "vitest";

import type { OverlayResolutionPathPrefixes } from "~/application/overlay-path-resolution-prefixes";
import { buildOverlayPathResolutionPrefixes } from "~/application/overlay-path-resolution-prefixes";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { ToolCall } from "~/domain/types/llm.types";
import { matchFilePathGlobWithLiteralPrefix } from "~/glob/match-file-path-glob";

import { OverlayViewService } from "./overlay-view.service";

interface OverlayDependencies {
  codeHost: ICodeHost;
  snapshotRepo: ISnapshotRepository;
}

interface OverlayTrackedTestDependencies extends OverlayDependencies {
  readonly fixtureBaselineTrackedFilePaths: readonly string[];
}

function createSnapshotRepo(
  baselineFiles: string[] = ["src/base.ts"],
): ISnapshotRepository & {
  getFileContentMock: ReturnType<typeof vi.fn>;
  listFilesMock: ReturnType<typeof vi.fn>;
  listPackageRootsFromSnapshotMock: ReturnType<typeof vi.fn>;
} {
  const getFileContentMock = vi.fn(() => Promise.resolve(null));
  const listPackageRootsFromSnapshotMock = vi.fn(
    (_projectId: number, _commitSha: string) =>
      Promise.resolve({
        hasTopLevelSrcTree: false,
        packageRoots: [] as readonly string[],
        packageRootsUsingSrc: [] as readonly string[],
      }),
  );
  const listFilesMock = vi.fn(
    (
      _projectId: number,
      _commitSha: string,
      pattern?: string,
    ): Promise<string[]> => {
      if (pattern === undefined) {
        return Promise.resolve(baselineFiles);
      }
      return Promise.resolve(
        baselineFiles.filter((filePath: string) =>
          matchFilePathGlobWithLiteralPrefix(filePath, pattern),
        ),
      );
    },
  );
  return {
    copySnapshotEntries: () => Promise.resolve(0),
    deleteCommit: () => Promise.resolve(),
    deleteOldSnapshotsBefore: () => Promise.resolve(0),
    getBaselineState: () => Promise.resolve(null),
    getFileContent: getFileContentMock,
    getFileContentMock,
    listFiles: listFilesMock,
    listFilesMock,
    listPackageRootsFromSnapshot: (
      ...args: Parameters<ISnapshotRepository["listPackageRootsFromSnapshot"]>
    ): ReturnType<ISnapshotRepository["listPackageRootsFromSnapshot"]> =>
      listPackageRootsFromSnapshotMock(...args),
    listPackageRootsFromSnapshotMock,
    searchContent: () => Promise.resolve([]),
    setBaselineState: () => Promise.resolve(),
    storeBlobs: () => Promise.resolve(),
    storeSnapshot: () => Promise.resolve(),
  };
}

function createCodeHost(): ICodeHost & {
  getFileContentMock: ReturnType<typeof vi.fn>;
} {
  const getFileContentMock = vi.fn(() =>
    Promise.resolve("changed file content"),
  );
  return {
    approveMergeRequest: () => Promise.resolve(),
    getBranchHeadSha: () => Promise.resolve("head"),
    getCommitRangeDiff: () => Promise.resolve([]),
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: getFileContentMock,
    getFileContentMock,
    getFileTree: () => Promise.resolve([]),
    getMergeRequestDiff: () => Promise.resolve([]),
    getMergeRequestInfo: () =>
      Promise.resolve({
        description: "",
        iid: 1,
        projectId: 1,
        sourceBranch: "feature",
        targetBranch: "main",
        title: "MR",
      }),
    getMergeRequestVersions: () =>
      Promise.resolve({
        baseSha: "base",
        headSha: "head",
        startSha: "start",
      }),
    getRepositoryArchive: () => Promise.resolve([]),
    listOpenMergeRequests: () => Promise.resolve([]),
    postInlineComment: () =>
      Promise.resolve({ discussionId: "discussion", noteId: "note" }),
    postNote: () => Promise.resolve({ noteId: "note" }),
    replyToDiscussion: () => Promise.resolve({ noteId: "note" }),
    resolveDiscussion: () => Promise.resolve(),
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: () => Promise.resolve(),
  };
}

function createOverlayDependencies(
  baselineFiles: string[] = ["src/base.ts"],
): OverlayTrackedTestDependencies & {
  codeHost: ICodeHost & { getFileContentMock: ReturnType<typeof vi.fn> };
  snapshotRepo: ISnapshotRepository & {
    getFileContentMock: ReturnType<typeof vi.fn>;
    listFilesMock: ReturnType<typeof vi.fn>;
    listPackageRootsFromSnapshotMock: ReturnType<typeof vi.fn>;
  };
} {
  const snapshotRepo = createSnapshotRepo(baselineFiles);
  const codeHost = createCodeHost();
  return {
    codeHost,
    fixtureBaselineTrackedFilePaths: baselineFiles.slice(),
    snapshotRepo,
  };
}

const SPEC_OVERLAY_DEFAULT_LIMITS = {
  maxListFiles: 200,
  maxMatchesPerFile: 5,
  maxReadFileChars: 6000,
  maxReadFileLines: 300,
  maxSearchResults: 20,
  maxToolResponseChars: 8000,
};

function synthesizeOverlayResolutionPrefixesUnderUnitMock(
  fixtureBaselineTracked: readonly string[],
  changedPathsRelative: readonly string[],
  mrDeletedRelative: readonly string[],
): OverlayResolutionPathPrefixes {
  const hasBaselineTopLevelMarkedSrcSubtree = fixtureBaselineTracked.some(
    (filePathCandidate) => filePathCandidate.startsWith("src/"),
  );
  return buildOverlayPathResolutionPrefixes({
    hasTopLevelSrcTree: hasBaselineTopLevelMarkedSrcSubtree,
    mrPaths: [...changedPathsRelative, ...mrDeletedRelative],
    packageRoots: [],
    packageRootsUsingSrcSubtree: [],
    workspaceUsesDeclaredPackages: false,
  });
}

function createOverlayService(
  dependenciesTracked: OverlayTrackedTestDependencies,
  changedPathsRelative: string[] = ["src/changed.ts"],
  mrDeletedRelative: string[] = [],
  limitsForToolCap = SPEC_OVERLAY_DEFAULT_LIMITS,
  explicitResolutionDeclared?: OverlayResolutionPathPrefixes,
): OverlayViewService {
  const synthesizedResolutionDeclared =
    explicitResolutionDeclared ??
    synthesizeOverlayResolutionPrefixesUnderUnitMock(
      dependenciesTracked.fixtureBaselineTrackedFilePaths,
      changedPathsRelative,
      mrDeletedRelative,
    );
  return new OverlayViewService(
    dependenciesTracked.snapshotRepo,
    dependenciesTracked.codeHost,
    10,
    "baseline-sha",
    "mr-head-sha",
    changedPathsRelative,
    mrDeletedRelative,
    synthesizedResolutionDeclared,
    limitsForToolCap,
  );
}

function createListFilesCall(
  argumentsValue: Record<string, unknown>,
): ToolCall {
  return {
    arguments: argumentsValue,
    id: "tool-1",
    name: "list_files",
  };
}

function createReadFileCall(argumentsValue: Record<string, unknown>): ToolCall {
  return {
    arguments: argumentsValue,
    id: "tool-1",
    name: "read_file",
  };
}

describe("OverlayViewService", () => {
  it("read_file returns MR head content for paths outside changed set before snapshot", async () => {
    const dependencies = createOverlayDependencies(["src/unchanged.ts"]);
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(
      "snapshot-body",
    );
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/unchanged.ts") {
          return Promise.resolve("mr-head-body");
        }
        return Promise.resolve("");
      },
    );
    const service = createOverlayService(dependencies, ["src/changed.ts"]);
    const actual = await service.readFile("src/unchanged.ts");
    expect(actual).toContain("mr-head-body");
    expect(dependencies.snapshotRepo.getFileContentMock).not.toHaveBeenCalled();
  });

  it("readFileAtBaseline prefers baseline snapshot bodies for MR changed paths", async () => {
    const dependencies = createOverlayDependencies(["src/changed.ts"]);
    dependencies.snapshotRepo.getFileContentMock.mockImplementation(
      (projectId, sha, path) => {
        if (
          projectId === 10 &&
          sha === "baseline-sha" &&
          path === "src/changed.ts"
        ) {
          return Promise.resolve("BASELINE_ONLY");
        }
        return Promise.resolve(null);
      },
    );
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/changed.ts") {
          return Promise.resolve("HEAD_ONLY");
        }
        return Promise.reject(new Error("unexpected baseline fetch"));
      },
    );
    const service = createOverlayService(dependencies, ["src/changed.ts"]);
    const baselineActual = await service.readFileAtBaseline("src/changed.ts");
    const headActual = await service.readFile("src/changed.ts");
    expect(baselineActual).toContain("BASELINE_ONLY");
    expect(headActual).toContain("HEAD_ONLY");
    expect(baselineActual).not.toContain("HEAD_ONLY");
  });

  it("read_file falls back to snapshot when MR head request fails", async () => {
    const dependencies = createOverlayDependencies(["src/unchanged.ts"]);
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(
      "snapshot-fallback",
    );
    dependencies.codeHost.getFileContentMock.mockRejectedValue(
      new Error("404"),
    );
    const service = createOverlayService(dependencies, ["src/changed.ts"]);
    const actual = await service.readFile("src/unchanged.ts");
    expect(actual).toContain("snapshot-fallback");
  });

  it("returns file list for list_files when pattern is missing", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const service = createOverlayService(dependencies, ["src/changed.ts"]);
    const executeToolCall = service.createToolExecutor();

    const actualResult = await executeToolCall(createListFilesCall({}));

    expect(actualResult).toContain("src/base.ts");
    expect(actualResult).toContain("src/changed.ts");
    expect(dependencies.snapshotRepo.listFilesMock).toHaveBeenCalledWith(
      10,
      "baseline-sha",
      undefined,
    );
  });

  it("returns argument error for list_files when pattern is not a string", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const service = createOverlayService(dependencies);
    const executeToolCall = service.createToolExecutor();

    const actualResult = await executeToolCall(
      createListFilesCall({ pattern: 123 }),
    );

    expect(actualResult).toBe(
      'Invalid arguments for list_files: Field "pattern" must be a string when provided.',
    );
  });

  it("keeps previous behavior for valid list_files pattern", async () => {
    const dependencies = createOverlayDependencies([
      "src/base.ts",
      "test/base.ts",
    ]);
    const service = createOverlayService(dependencies, ["src/changed.ts"]);
    const executeToolCall = service.createToolExecutor();

    const actualResult = await executeToolCall(
      createListFilesCall({ pattern: "src/" }),
    );

    expect(actualResult).toContain("src/base.ts");
    expect(actualResult).toContain("src/changed.ts");
    expect(actualResult).not.toContain("test/base.ts");
  });

  it("list_files matches nested paths for ** glob pattern", async () => {
    const dependencies = createOverlayDependencies([
      "src/deep/nested/file.ts",
      "other/root.ts",
    ]);
    const service = createOverlayService(dependencies, ["src/new.ts"]);
    const executeToolCall = service.createToolExecutor();

    const actualResult = await executeToolCall(
      createListFilesCall({ pattern: "src/**/*.ts" }),
    );

    expect(actualResult).toContain("src/deep/nested/file.ts");
    expect(actualResult).toContain("src/new.ts");
    expect(actualResult).not.toContain("other/root.ts");
  });

  it("limits read_file output to maxReadFileLines and adds truncation marker", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const multiline = "line1\nline2\nline3\nline4\nline5";
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(multiline);
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/base.ts") {
          return Promise.resolve(multiline);
        }
        return Promise.resolve("changed file content");
      },
    );
    const service = createOverlayService(dependencies, [], [], {
      maxListFiles: 200,
      maxMatchesPerFile: 5,
      maxReadFileChars: 6000,
      maxReadFileLines: 3,
      maxSearchResults: 20,
      maxToolResponseChars: 8000,
    });
    const actualResult = await service.readFile("src/base.ts");
    expect(actualResult).toContain("line1\nline2\nline3");
    expect(actualResult).not.toContain("line4");
    expect(actualResult).toContain(
      "[read_file] total_file_lines=5 visible_line_range=1-3",
    );
    expect(actualResult).not.toContain("requested_line_range");
    expect(actualResult).toContain(
      "[truncation:read_file_lines] limit=3 lines_in_window=5 visible_line_range=1-3",
    );
  });

  it("applies read_file range before line and char limits", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const multiline = "line1\nline2\nline3\nline4\nline5";
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(multiline);
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/base.ts") {
          return Promise.resolve(multiline);
        }
        return Promise.resolve("changed file content");
      },
    );
    const service = createOverlayService(dependencies, [], [], {
      maxListFiles: 200,
      maxMatchesPerFile: 5,
      maxReadFileChars: 6000,
      maxReadFileLines: 3,
      maxSearchResults: 20,
      maxToolResponseChars: 8000,
    });
    const actualResult = await service.readFile("src/base.ts", 2, 5, 8);
    expect(actualResult).toContain("line2");
    expect(actualResult).toContain("requested_line_range=2-5");
    expect(actualResult).toContain("visible_line_range=2-4");
    expect(actualResult).toContain(
      "[truncation:read_file_lines] limit=3 lines_in_window=4 visible_line_range=2-4",
    );
    expect(actualResult).toContain(
      "[truncation:read_file_chars] effective_limit=8 size_before_truncation=17",
    );
  });

  it("keeps read_file limits when changed file is served from cache", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const codeHostGetFileContentSpy = vi
      .spyOn(dependencies.codeHost, "getFileContent")
      .mockResolvedValue("line1\nline2\nline3\nline4");
    const service = createOverlayService(dependencies, ["src/changed.ts"], [], {
      maxListFiles: 200,
      maxMatchesPerFile: 5,
      maxReadFileChars: 6000,
      maxReadFileLines: 2,
      maxSearchResults: 20,
      maxToolResponseChars: 8000,
    });
    const firstResult = await service.readFile("src/changed.ts");
    const secondResult = await service.readFile("src/changed.ts");
    expect(firstResult).toContain("line1\nline2");
    expect(firstResult).not.toContain("line3");
    expect(secondResult).toContain("line1\nline2");
    expect(secondResult).not.toContain("line3");
    expect(secondResult).toContain(
      "[truncation:read_file_lines] limit=2 lines_in_window=4 visible_line_range=1-2",
    );
    expect(codeHostGetFileContentSpy).toHaveBeenCalledTimes(1);
  });

  it("reads unchanged files from MR head when available", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(
      "snapshot content",
    );
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/base.ts") {
          return Promise.resolve("mr-head content");
        }
        return Promise.resolve("changed file content");
      },
    );
    const service = createOverlayService(dependencies, ["src/changed.ts"]);

    const result = await service.readFile("src/base.ts");

    expect(result).toContain("mr-head content");
    expect(result).toBe("mr-head content");
    expect(dependencies.codeHost.getFileContentMock).toHaveBeenCalled();
  });

  it("read_file tool returns bare content for small full file without range", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue("ok");
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/base.ts") {
          return Promise.resolve("ok");
        }
        return Promise.resolve("changed file content");
      },
    );
    const service = createOverlayService(dependencies, []);
    const executeToolCall = service.createToolExecutor();
    const actualResult = await executeToolCall(
      createReadFileCall({ path: "src/base.ts" }),
    );
    expect(actualResult).toBe("ok");
  });

  it("read_file tool wraps with tool_response_chars when over maxToolResponseChars", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const longBody = "a".repeat(120);
    dependencies.snapshotRepo.getFileContentMock.mockResolvedValue(longBody);
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_projectId: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "src/base.ts") {
          return Promise.resolve(longBody);
        }
        return Promise.resolve("changed file content");
      },
    );
    const service = createOverlayService(dependencies, [], [], {
      maxListFiles: 200,
      maxMatchesPerFile: 5,
      maxReadFileChars: 6000,
      maxReadFileLines: 300,
      maxSearchResults: 20,
      maxToolResponseChars: 50,
    });
    const executeToolCall = service.createToolExecutor();
    const actualResult = await executeToolCall(
      createReadFileCall({ path: "src/base.ts" }),
    );
    expect(actualResult).toContain("[truncation:tool_response_chars]");
    expect(actualResult).toContain("limit=50");
    expect(actualResult).toContain("total=120");
    expect(actualResult.length).toBeGreaterThan(50);
  });

  it("direct readFile is not capped by maxToolResponseChars", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.codeHost.getFileContentMock.mockResolvedValue("b".repeat(200));
    const service = createOverlayService(dependencies, ["src/changed.ts"], [], {
      maxListFiles: 200,
      maxMatchesPerFile: 5,
      maxReadFileChars: 6000,
      maxReadFileLines: 300,
      maxSearchResults: 20,
      maxToolResponseChars: 40,
    });
    const actualResult = await service.readFile("src/changed.ts");
    expect(actualResult).toBe("b".repeat(200));
    expect(actualResult).not.toContain("tool_response_chars");
  });

  it("does not refetch a changed file from external code host on repeated reads", async () => {
    const changedFiles = Array.from(
      { length: 10 },
      (_, i) => `src/changed${String(i)}.ts`,
    );
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.codeHost.getFileContentMock.mockResolvedValue("content");
    const service = createOverlayService(dependencies, changedFiles);

    for (let round = 0; round < 3; round++) {
      for (const path of changedFiles) {
        await service.readFile(path);
      }
    }
    await service.searchContent("content");

    expect(
      dependencies.codeHost.getFileContentMock.mock.calls.length,
    ).toBeLessThanOrEqual(changedFiles.length);
  });

  it("reads changed file when read_file path has ./ prefix", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.codeHost.getFileContentMock.mockResolvedValue(
      "normalized changed content",
    );
    const service = createOverlayService(dependencies, [
      "src/user/user.router.ts",
    ]);

    const actualResult = await service.readFile("./src/user/user.router.ts");

    expect(actualResult).toContain("normalized changed content");
    expect(dependencies.codeHost.getFileContentMock).toHaveBeenCalledWith(
      10,
      "mr-head-sha",
      "src/user/user.router.ts",
    );
  });

  it("resolves src fallback only when MR has src-prefixed paths", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.codeHost.getFileContentMock.mockResolvedValue(
      "src fallback content",
    );
    const service = createOverlayService(dependencies, [
      "src/user/user.router.ts",
    ]);

    const actualResult = await service.readFile("user/user.router.ts");

    expect(actualResult).toContain("src fallback content");
    expect(dependencies.codeHost.getFileContentMock).toHaveBeenCalledWith(
      10,
      "mr-head-sha",
      "src/user/user.router.ts",
    );
  });

  it("returns ambiguous path error for non-unique suffix match", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    const service = createOverlayService(dependencies, [
      "src/user/user.router.ts",
      "apps/web/user/user.router.ts",
    ]);

    const actualResult = await service.readFile("user/user.router.ts");

    expect(actualResult).toContain("Ambiguous path: user/user.router.ts");
    expect(actualResult).toContain("apps/web/user/user.router.ts");
    expect(actualResult).toContain("src/user/user.router.ts");
    expect(dependencies.codeHost.getFileContentMock).not.toHaveBeenCalled();
  });

  it("resolves shortened read_file paths through nested package src subtree prefixes", async () => {
    const dependencies = createOverlayDependencies([
      "services/pkg/src/module/x.ts",
    ]);
    dependencies.codeHost.getFileContentMock.mockImplementation(
      (_pid: number, sha: string, path: string) => {
        if (sha === "mr-head-sha" && path === "services/pkg/src/module/x.ts") {
          return Promise.resolve("nested_pkg_src_body");
        }
        return Promise.resolve("");
      },
    );
    const explicitResolutionDeclaredPrefixes: OverlayResolutionPathPrefixes = {
      prefixes: ["services/pkg"],
      prefixesUsingSrcSubtree: ["services/pkg"],
    };
    const service = createOverlayService(
      dependencies,
      ["services/pkg/src/module/x.ts"],
      [],
      SPEC_OVERLAY_DEFAULT_LIMITS,
      explicitResolutionDeclaredPrefixes,
    );

    const actualDeclaredRead = await service.readFile("module/x.ts");

    expect(actualDeclaredRead).toContain("nested_pkg_src_body");
    expect(dependencies.codeHost.getFileContentMock).toHaveBeenCalledWith(
      10,
      "mr-head-sha",
      "services/pkg/src/module/x.ts",
    );
  });

  it("search_content keeps MR file when changed path has ./ prefix", async () => {
    const dependencies = createOverlayDependencies(["src/base.ts"]);
    dependencies.codeHost.getFileContentMock.mockResolvedValue(
      "export const marker = 'found';",
    );
    const service = createOverlayService(dependencies, ["./src/changed.ts"]);

    const actualResult = await service.searchContent("marker");

    expect(actualResult).toContain("--- src/changed.ts ---");
    expect(actualResult).toMatch(/(^|\n)1:.*marker/);
  });
});
