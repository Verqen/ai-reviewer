import { minimatch } from "minimatch";

type OverlayResolutionPathPrefixes = Readonly<{
  prefixes: readonly string[];
  prefixesUsingSrcSubtree: readonly string[];
}>;

const DEFAULT_MAX_OVERLAY_PATH_PREFIXES = 96;

function normalizeRelativeRepoPath(segment: string): string {
  return segment
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function collectMrTwoSegmentPrefixes(mrPaths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of mrPaths) {
    const normalized = normalizeRelativeRepoPath(path);
    if (normalized === "") continue;
    const firstSlashAt = normalized.indexOf("/");
    if (firstSlashAt === -1) continue;
    const secondSlashAt = normalized.indexOf("/", firstSlashAt + 1);
    const twoSegmentLead =
      secondSlashAt === -1 ? normalized : normalized.slice(0, secondSlashAt);
    if (twoSegmentLead.length === 0 || seen.has(twoSegmentLead)) continue;
    seen.add(twoSegmentLead);
    out.push(twoSegmentLead);
  }
  return out;
}

function mrTouchesDeclaredSrcFolder(mrPaths: readonly string[]): boolean {
  for (const path of mrPaths) {
    const normalized = normalizeRelativeRepoPath(path);
    if (normalized === "") continue;
    if (normalized === "src" || normalized.startsWith("src/")) {
      return true;
    }
  }
  return false;
}

function filterPackageRootsUsingWorkspaceDeclaredGlobs(
  packageRoots: readonly string[],
  workspaceGlobs: readonly string[],
  usesWorkspaceDeclaredPackagesList: boolean
): readonly string[] {
  if (!usesWorkspaceDeclaredPackagesList || workspaceGlobs.length === 0) {
    return packageRoots;
  }
  const filtered = packageRoots.filter((rootCandidate) =>
    workspaceGlobs.some((globCandidate) =>
      minimatch(rootCandidate, globCandidate, { dot: true })
    )
  );
  return filtered.length > 0 ? filtered : [...packageRoots];
}

type BuildOverlayPathResolutionPrefixesParams = Readonly<{
  hasTopLevelSrcTree: boolean;
  maxPrefixes?: number | undefined;
  mrPaths: readonly string[];
  packageRoots: readonly string[];
  packageRootsUsingSrcSubtree: readonly string[];
  workspaceGlobs?: readonly string[] | undefined;
  workspaceUsesDeclaredPackages?: boolean | undefined;
}>;

function buildOverlayPathResolutionPrefixes(
  params: BuildOverlayPathResolutionPrefixesParams
): OverlayResolutionPathPrefixes {
  const maxPrefixes = params.maxPrefixes ?? DEFAULT_MAX_OVERLAY_PATH_PREFIXES;
  const filteredRootsByWorkspace =
    filterPackageRootsUsingWorkspaceDeclaredGlobs(
      params.packageRoots,
      params.workspaceGlobs ?? [],
      params.workspaceUsesDeclaredPackages ?? false
    );
  const rootsMarkedUsingSrcSubtreeFiltered =
    params.packageRootsUsingSrcSubtree.filter((candidate) =>
      filteredRootsByWorkspace.includes(candidate)
    );
  const rootsMarkedUsingSubtree = new Set(rootsMarkedUsingSrcSubtreeFiltered);
  const ordered: string[] = [];
  const dedupeSet = new Set<string>();
  const pushDistinctTrailing = (value: string): void => {
    if (
      value.length === 0 ||
      dedupeSet.has(value) ||
      ordered.length >= maxPrefixes
    )
      return;
    ordered.push(value);
    dedupeSet.add(value);
  };
  for (const mrPrefixCandidate of collectMrTwoSegmentPrefixes(params.mrPaths)) {
    pushDistinctTrailing(mrPrefixCandidate);
    if (ordered.length >= maxPrefixes)
      return finalizeOverlayPrefixes({
        rootsMarkedUsingSubtree,
        trimmedOrdered: ordered.slice(),
      });
  }
  if (mrTouchesDeclaredSrcFolder(params.mrPaths) || params.hasTopLevelSrcTree)
    pushDistinctTrailing("src");
  const alphabeticalRoots = [...filteredRootsByWorkspace].sort((lead, trail) =>
    lead.localeCompare(trail)
  );
  for (const rootCandidate of alphabeticalRoots) {
    pushDistinctTrailing(rootCandidate);
    if (ordered.length >= maxPrefixes) break;
  }
  return finalizeOverlayPrefixes({
    rootsMarkedUsingSubtree,
    trimmedOrdered: ordered.slice(),
  });
}

type FinalizeOverlayPrefixesArgs = Readonly<{
  rootsMarkedUsingSubtree: ReadonlySet<string>;
  trimmedOrdered: readonly string[];
}>;

function finalizeOverlayPrefixes(
  params: FinalizeOverlayPrefixesArgs
): OverlayResolutionPathPrefixes {
  const prefixesUsingSrcSubtree: string[] = [];
  const { rootsMarkedUsingSubtree, trimmedOrdered } = params;
  for (const prefixCandidate of trimmedOrdered) {
    if (
      prefixCandidate !== "src" &&
      rootsMarkedUsingSubtree.has(prefixCandidate)
    ) {
      prefixesUsingSrcSubtree.push(prefixCandidate);
    }
  }
  return {
    prefixes: trimmedOrdered.slice(),
    prefixesUsingSrcSubtree,
  };
}

export type { OverlayResolutionPathPrefixes };
export {
  DEFAULT_MAX_OVERLAY_PATH_PREFIXES,
  buildOverlayPathResolutionPrefixes,
  filterPackageRootsUsingWorkspaceDeclaredGlobs,
};
