import { parse } from "yaml";

type PnpmWorkspaceYamlDoc = Record<string, unknown>;

type ParsedWorkspaceYamlFilterOutcome = Readonly<{
  filterActiveForPackageRoots: boolean;
  packageRootPathGlobs: readonly string[];
}>;

function normalizeNonBlankTrimmedYamlOrUndefined(
  rawYaml: string | null | undefined
): string | undefined {
  if (typeof rawYaml !== "string") {
    return undefined;
  }
  const trimmedYaml = rawYaml.trim();
  if (trimmedYaml.length === 0) return undefined;
  return trimmedYaml;
}

function collectNonEmptyTrimmedGlobEntries(candidate: unknown): string[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const list: string[] = [];
  const visited = new Set<string>();
  for (const candidateEntry of candidate) {
    if (typeof candidateEntry !== "string") continue;
    const trimmedEntry = candidateEntry.trim();
    if (trimmedEntry.length === 0 || visited.has(trimmedEntry)) continue;
    visited.add(trimmedEntry);
    list.push(trimmedEntry);
  }
  return list;
}

function mapWorkspaceYamlObjectToDeclaredFilter(
  doc: PnpmWorkspaceYamlDoc
): ParsedWorkspaceYamlFilterOutcome {
  if (!Object.hasOwn(doc, "packages")) {
    return { filterActiveForPackageRoots: false, packageRootPathGlobs: [] };
  }
  const packageRootPathGlobs = collectNonEmptyTrimmedGlobEntries(
    doc["packages"]
  );
  if (packageRootPathGlobs.length === 0) {
    return { filterActiveForPackageRoots: false, packageRootPathGlobs: [] };
  }
  return {
    filterActiveForPackageRoots: true,
    packageRootPathGlobs,
  };
}

function deriveWorkspaceFilterFromYamlDocument(
  rawYaml: string | null | undefined,
  workspaceYamlParseFailed: { value: boolean }
): ParsedWorkspaceYamlFilterOutcome {
  const trimmed = normalizeNonBlankTrimmedYamlOrUndefined(rawYaml);
  if (trimmed === undefined) {
    return { filterActiveForPackageRoots: false, packageRootPathGlobs: [] };
  }
  try {
    const parsedBody = parse(trimmed) as unknown;
    if (
      typeof parsedBody !== "object" ||
      parsedBody === null ||
      Array.isArray(parsedBody)
    )
      return { filterActiveForPackageRoots: false, packageRootPathGlobs: [] };
    const doc = parsedBody as PnpmWorkspaceYamlDoc;
    return mapWorkspaceYamlObjectToDeclaredFilter(doc);
  } catch {
    workspaceYamlParseFailed.value = true;
    return { filterActiveForPackageRoots: false, packageRootPathGlobs: [] };
  }
}

export type { ParsedWorkspaceYamlFilterOutcome };

export { deriveWorkspaceFilterFromYamlDocument };
