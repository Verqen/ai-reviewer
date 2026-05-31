import { posix as pathPosix } from "node:path";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { Finding } from "~/domain/types/review.types";

// Dual-language matchers: model output may be in English or Russian depending on REVIEW_LANGUAGE.
// Keep both patterns so the validator catches "missing import" claims regardless of locale.
const MISSING_FILE_CLAIM_REGEX =
  /(does\s+not\s+exist|not\s+found|missing\s+file|не\s+существ|несуществующ|не\s+найден)/i;
const IMPORT_MENTION_REGEX = /(import|импорт)/i;
const QUOTED_PATH_REGEX = /['"`]([^'"`\n]+)['"`]/g;
const FILE_EXTENSION_REGEX = /\.[A-Za-z0-9]+$/;
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

type MissingImportValidationOutcome =
  | {
      extractedPath?: string | undefined;
      reason: "claim_not_missing_import";
      shouldDrop: false;
    }
  | {
      extractedPath?: string | undefined;
      reason: "path_extracted";
      shouldDrop: false;
    }
  | {
      extractedPath?: string | undefined;
      resolvedPath?: string | undefined;
      reason:
        | "path_exists_at_head"
        | "path_not_extractable"
        | "path_unresolvable";
      shouldDrop: true;
    };

function isMissingImportClaim(comment: string): boolean {
  return (
    MISSING_FILE_CLAIM_REGEX.test(comment) && IMPORT_MENTION_REGEX.test(comment)
  );
}

function extractImportPath(comment: string): string | undefined {
  const matches = [...comment.matchAll(QUOTED_PATH_REGEX)];
  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    if (
      candidate.startsWith("./") ||
      candidate.startsWith("../") ||
      candidate.startsWith("/") ||
      candidate.startsWith("src/")
    ) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeRepoPath(path: string): string {
  const normalized = path
    .trim()
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/");
  return pathPosix.normalize(normalized);
}

function resolveImportPathToRepoPath(params: {
  importerFilePath: string;
  importPath: string;
}): string | undefined {
  const { importerFilePath, importPath } = params;
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const importerDir = pathPosix.dirname(importerFilePath);
    const resolved = normalizeRepoPath(pathPosix.join(importerDir, importPath));
    if (resolved.startsWith("../")) {
      return undefined;
    }
    return resolved;
  }
  if (importPath.startsWith("/")) {
    const normalized = normalizeRepoPath(importPath);
    return normalized.startsWith("../") ? undefined : normalized;
  }
  if (importPath.startsWith("src/")) {
    const normalized = normalizeRepoPath(importPath);
    return normalized.startsWith("../") ? undefined : normalized;
  }
  return undefined;
}

function buildCandidatePaths(resolvedPath: string): string[] {
  if (FILE_EXTENSION_REGEX.test(resolvedPath)) {
    return [resolvedPath];
  }
  const candidates = new Set<string>();
  candidates.add(resolvedPath);
  for (const ext of RESOLUTION_EXTENSIONS) {
    candidates.add(`${resolvedPath}${ext}`);
    candidates.add(pathPosix.join(resolvedPath, `index${ext}`));
  }
  return [...candidates];
}

async function doesAnyPathExistAtHead(params: {
  candidatePaths: readonly string[];
  codeHost: ICodeHost;
  headSha: string;
  projectId: number;
}): Promise<boolean> {
  const { candidatePaths, codeHost, headSha, projectId } = params;
  for (const candidatePath of candidatePaths) {
    try {
      await codeHost.getFileContent(projectId, headSha, candidatePath);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function validateMissingImportFinding(params: {
  codeHost: ICodeHost;
  finding: Finding;
  headSha: string;
  projectId: number;
}): Promise<MissingImportValidationOutcome> {
  const { codeHost, finding, headSha, projectId } = params;
  if (!isMissingImportClaim(finding.comment)) {
    return { reason: "claim_not_missing_import", shouldDrop: false };
  }
  const extractedPath = extractImportPath(finding.comment);
  if (!extractedPath) {
    return { reason: "path_not_extractable", shouldDrop: true };
  }
  const resolvedPath = resolveImportPathToRepoPath({
    importerFilePath: finding.filePath,
    importPath: extractedPath,
  });
  if (!resolvedPath) {
    return {
      extractedPath,
      reason: "path_unresolvable",
      shouldDrop: true,
    };
  }
  const candidatePaths = buildCandidatePaths(resolvedPath);
  const exists = await doesAnyPathExistAtHead({
    candidatePaths,
    codeHost,
    headSha,
    projectId,
  });
  if (exists) {
    return {
      extractedPath,
      reason: "path_exists_at_head",
      resolvedPath,
      shouldDrop: true,
    };
  }
  return {
    extractedPath,
    reason: "path_extracted",
    shouldDrop: false,
  };
}

export { validateMissingImportFinding };
export type { MissingImportValidationOutcome };
