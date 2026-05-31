import type { ParsedFileDiff } from "~/domain/types/diff.types";

function buildOverlayPathListsFromParsedDiffs(
  parsedDiffs: readonly ParsedFileDiff[],
): { changedPaths: string[]; deletedPaths: string[] } {
  const deletedPaths = parsedDiffs
    .filter((d) => d.newPath === "/dev/null" || d.lines.length === 0)
    .map((d) => d.oldPath)
    .filter((p) => p.length > 0 && p !== "/dev/null");
  const changedPaths = parsedDiffs
    .map((d) => d.newPath)
    .filter((p) => p.length > 0 && p !== "/dev/null");
  return { changedPaths, deletedPaths };
}

export { buildOverlayPathListsFromParsedDiffs };
