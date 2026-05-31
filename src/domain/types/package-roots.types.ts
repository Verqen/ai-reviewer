type PackageRootsInsight = Readonly<{
  hasTopLevelSrcTree: boolean;
  packageRoots: readonly string[];
  packageRootsUsingSrc: readonly string[];
}>;

export type { PackageRootsInsight };
