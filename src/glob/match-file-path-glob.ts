import { Minimatch, minimatch } from "minimatch";

const FILE_PATH_GLOB_MINIMATCH_OPTIONS = {
  dot: true,
} as const;

function normalizeFilePathForGlob(path: string): string {
  return path.replace(/\\/g, "/");
}

function matchFilePathGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeFilePathForGlob(filePath);
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  return minimatch(
    normalizedPath,
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  );
}

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

function filePathGlobPatternHasMagic(pattern: string): boolean {
  const normalizedPattern = normalizeFilePathForGlob(pattern);
  return new Minimatch(
    normalizedPattern,
    FILE_PATH_GLOB_MINIMATCH_OPTIONS,
  ).hasMagic();
}

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
