import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

function createMockSnapshotRepository(
  overrides: Partial<ISnapshotRepository> = {},
): ISnapshotRepository {
  return {
    copySnapshotEntries: () => Promise.resolve(0),
    deleteCommit: () => Promise.resolve(),
    deleteOldSnapshotsBefore: () => Promise.resolve(0),
    getBaselineState: () => Promise.resolve(null),
    getFileContent: () => Promise.resolve(null),
    listFiles: () => Promise.resolve([]),
    listPackageRootsFromSnapshot: () =>
      Promise.resolve({
        hasTopLevelSrcTree: false,
        packageRoots: [],
        packageRootsUsingSrc: [],
      }),
    searchContent: () => Promise.resolve([]),
    setBaselineState: () => Promise.resolve(),
    storeBlobs: () => Promise.resolve(),
    storeSnapshot: () => Promise.resolve(),
    ...overrides,
  };
}

export { createMockSnapshotRepository };
