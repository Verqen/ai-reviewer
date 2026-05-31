import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_OVERLAY_PATH_PREFIXES,
  buildOverlayPathResolutionPrefixes,
  filterPackageRootsUsingWorkspaceDeclaredGlobs,
} from "~/application/overlay-path-resolution-prefixes";

describe("filterPackageRootsUsingWorkspaceDeclaredGlobs", () => {
  it("drops roots outside globs while active filter declares packages workspace", () => {
    const excludedOutsideWorkspace =
      filterPackageRootsUsingWorkspaceDeclaredGlobs(
        ["apps/web", "orphan/root", "services/ai"],
        ["apps/*", "services/*"],
        true
      );
    expect(excludedOutsideWorkspace).toEqual(["apps/web", "services/ai"]);
  });

  it("returns every root when workspace filter mode is inactive", () => {
    const unfilteredRepeated = filterPackageRootsUsingWorkspaceDeclaredGlobs(
      ["a", "b"],
      ["packages/*"],
      false
    );
    expect(unfilteredRepeated).toEqual(["a", "b"]);
  });

  it("falls back preserving all roots after glob intersections empty unexpectedly", () => {
    const rootRowsBeforeFallbackHandling =
      filterPackageRootsUsingWorkspaceDeclaredGlobs(
        ["orphan/x", "orphan/y"],
        ["packages/*"],
        true
      );
    expect(rootRowsBeforeFallbackHandling).toEqual(["orphan/x", "orphan/y"]);
  });
});

describe("buildOverlayPathResolutionPrefixes", () => {
  it("orders MR two-segment lead before alphabetical roots and caps prefixes", () => {
    const rootLabelsLong = Array.from(
      { length: DEFAULT_MAX_OVERLAY_PATH_PREFIXES + 5 },
      (_ignored: unknown, ordinal: number) => `p${ordinal}`
    );
    const actualOrderedCap = buildOverlayPathResolutionPrefixes({
      hasTopLevelSrcTree: false,
      mrPaths: ["svc/z/deep/path.ts"],
      packageRoots: rootLabelsLong,
      packageRootsUsingSrcSubtree: [],
      workspaceUsesDeclaredPackages: false,
    });
    expect(actualOrderedCap.prefixes[0]).toBe("svc/z");
    expect(actualOrderedCap.prefixes).toHaveLength(
      DEFAULT_MAX_OVERLAY_PATH_PREFIXES
    );
  });

  it("flags subtree src layout only for intersections retained after workspace filter activation", () => {
    const actualUsingSrcSubtree = buildOverlayPathResolutionPrefixes({
      hasTopLevelSrcTree: false,
      mrPaths: [],
      packageRoots: ["apps/web", "orphan/other"],
      packageRootsUsingSrcSubtree: ["apps/web", "orphan/other"],
      workspaceGlobs: ["apps/*"],
      workspaceUsesDeclaredPackages: true,
    });
    expect(actualUsingSrcSubtree.prefixes).toContain("apps/web");
    expect(actualUsingSrcSubtree.prefixes).not.toContain("orphan/other");
    expect(actualUsingSrcSubtree.prefixesUsingSrcSubtree).toEqual(["apps/web"]);
  });
});
