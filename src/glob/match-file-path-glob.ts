import { Minimatch, minimatch } from "minimatch";

const FILE_PATH_GLOB_MINIMATCH_OPTIONS = {
  dot: true,
} as const;

/**
 * Normalizes path separators to `/` for consistent glob matching.
 */
function normalizeFilePathForGlob(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Full-path glob match (pipeline rules, dismissed patterns).
 */
function matchFilePathGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeFilePathForGlob(filePath);
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  return minimatch(
    normalizedPath,
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  );
}

/**
 * Overlay tools: literal patterns (no glob magic) match as string prefix; otherwise minimatch.
 */
function matchFilePathGlobWithLiteralPrefix(
  filePath: string,
  pattern: string,
): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return true;
  }
  const normalizedPath = normalizeFilePathForGlob(filePath);
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  const matcher = new Minimatch(
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  );
  if (!matcher.hasMagic()) {
    return normalizedPath.startsWith(normalizedPattern);
  }
  return minimatch(
    normalizedPath,
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  );
}

/**
 * Whether the pattern uses glob metacharacters (for SQL branch selection).
 */
function filePathGlobPatternHasMagic(pattern: string): boolean {
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  return new Minimatch(
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  ).hasMagic();
}

/**
 * POSIX regex source for PostgreSQL `~`, or null if the pattern cannot be compiled.
 */
function getFilePathGlobPosixRegexSource(pattern: string): string | null {
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  const compiled = minimatch.makeRe(
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  );
  if (compiled === false) {
    return null;
  }
  return compiled.source;
}

export {
  filePathGlobPatternHasMagic,
  getFilePathGlobPosixRegexSource,
  matchFilePathGlob,
  matchFilePathGlobWithLiteralPrefix,
  normalizeFilePathForGlob,
};
