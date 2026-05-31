import type { FastifyBaseLogger } from "fastify";

import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

type ArchitectureSnapshotLimits = {
  readonly maxFileChars: number;
  readonly maxListFiles: number;
  readonly maxTotalChars: number;
};

type BuildArchitectureSnapshotParams = {
  commitSha: string;
  limits: ArchitectureSnapshotLimits;
  logger: FastifyBaseLogger;
  projectId: number;
  snapshotRepo: ISnapshotRepository;
};

async function buildArchitectureSnapshot(
  params: BuildArchitectureSnapshotParams
): Promise<string | undefined> {
  const { commitSha, limits, logger, projectId, snapshotRepo } = params;
  try {
    const [packageJsonRaw, claudeMdRaw, srcFilesRaw] = await Promise.all([
      snapshotRepo.getFileContent(projectId, commitSha, "package.json"),
      snapshotRepo.getFileContent(projectId, commitSha, "CLAUDE.md"),
      snapshotRepo.listFiles(projectId, commitSha, "**/src/**"),
    ]);
    const packageJson = packageJsonRaw?.slice(0, limits.maxFileChars) ?? null;
    const claudeMd = claudeMdRaw?.slice(0, limits.maxFileChars) ?? null;
    const srcFiles = srcFilesRaw.slice(0, limits.maxListFiles);
    const truncatedList = srcFilesRaw.length > srcFiles.length;
    const truncatedPackageJson =
      packageJsonRaw !== null && packageJsonRaw.length > limits.maxFileChars;
    const truncatedClaudeMd =
      claudeMdRaw !== null && claudeMdRaw.length > limits.maxFileChars;
    const parts: string[] = [];
    if (packageJson) {
      parts.push("<package_json>", packageJson, "</package_json>");
    }
    if (srcFiles.length > 0) {
      parts.push("<src_structure>", srcFiles.join("\n"), "</src_structure>");
    }
    if (claudeMd) {
      parts.push("<claude_md>", claudeMd, "</claude_md>");
    }
    if (parts.length === 0) return undefined;
    const assembled = parts.join("\n");
    const truncatedTotal = assembled.length > limits.maxTotalChars;
    const output = truncatedTotal
      ? `${assembled.slice(0, limits.maxTotalChars)}\n<!-- truncated -->`
      : assembled;
    if (
      truncatedList ||
      truncatedPackageJson ||
      truncatedClaudeMd ||
      truncatedTotal
    ) {
      logger.warn(
        {
          limits,
          projectId,
          truncatedClaudeMd,
          truncatedList,
          truncatedPackageJson,
          truncatedTotal,
        },
        "Architecture snapshot clamped by limits"
      );
    }
    return output;
  } catch (err) {
    logger.warn(
      { err, projectId },
      "Failed to build architecture snapshot; file-review will fall back to no snapshot"
    );
    return undefined;
  }
}

export type { ArchitectureSnapshotLimits };
export { buildArchitectureSnapshot };
