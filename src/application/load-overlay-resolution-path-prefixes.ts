import type { FastifyBaseLogger } from "fastify";

import {
  DEFAULT_MAX_OVERLAY_PATH_PREFIXES,
  type OverlayResolutionPathPrefixes,
  buildOverlayPathResolutionPrefixes,
} from "~/application/overlay-path-resolution-prefixes";
import { deriveWorkspaceFilterFromYamlDocument } from "~/application/parse-pnpm-workspace";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

type LoadOverlayResolutionPathPrefixesParams = Readonly<{
  baselineCommitSha: string;
  mrChangedPaths: readonly string[];
  mrDeletedPaths: readonly string[];
  logger: FastifyBaseLogger;
  projectId: number;
  snapshotRepo: ISnapshotRepository;
}>;

async function loadOverlayResolutionPathPrefixesFromBaselineSnapshot(
  params: LoadOverlayResolutionPathPrefixesParams,
): Promise<OverlayResolutionPathPrefixes> {
  const mrPathsCombined = [...params.mrChangedPaths, ...params.mrDeletedPaths];
  const yamlParseMarkedFailureHint = { value: false };
  const [scopedPackageRootsDetected, maybePnpmWorkspaceRawSource] =
    await Promise.all([
      params.snapshotRepo.listPackageRootsFromSnapshot(
        params.projectId,
        params.baselineCommitSha,
      ),
      params.snapshotRepo.getFileContent(
        params.projectId,
        params.baselineCommitSha,
        "pnpm-workspace.yaml",
      ),
    ]);
  const declaredWorkspaceGlobFilterApplied =
    deriveWorkspaceFilterFromYamlDocument(
      maybePnpmWorkspaceRawSource,
      yamlParseMarkedFailureHint,
    );
  if (yamlParseMarkedFailureHint.value) {
    params.logger.warn(
      {
        baselineCommitSha: params.baselineCommitSha,
        projectId: params.projectId,
      },
      "pnpmWorkspaceYamlParseFailedUsingUnfilteredPackageRoots",
    );
  }
  return buildOverlayPathResolutionPrefixes({
    hasTopLevelSrcTree: scopedPackageRootsDetected.hasTopLevelSrcTree,
    maxPrefixes: DEFAULT_MAX_OVERLAY_PATH_PREFIXES,
    mrPaths: mrPathsCombined,
    packageRoots: scopedPackageRootsDetected.packageRoots,
    packageRootsUsingSrcSubtree:
      scopedPackageRootsDetected.packageRootsUsingSrc,
    workspaceGlobs: declaredWorkspaceGlobFilterApplied.packageRootPathGlobs,
    workspaceUsesDeclaredPackages:
      declaredWorkspaceGlobFilterApplied.filterActiveForPackageRoots,
  });
}

export { loadOverlayResolutionPathPrefixesFromBaselineSnapshot };
