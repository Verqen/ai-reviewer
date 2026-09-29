interface FingerprintedFinding {
  filePath: string;
  fingerprint: string;
  line: number;
  ruleId: string;
}

interface PersistingFinding {
  baseline: FingerprintedFinding;
  current: FingerprintedFinding;
  moved: boolean;
}

interface ResolvedFinding {
  fileRemoved: boolean;
  finding: FingerprintedFinding;
}

interface FindingComparison {
  new: FingerprintedFinding[];
  notComparable: number;
  persisting: PersistingFinding[];
  resolved: ResolvedFinding[];
}

interface FindingComparisonInput {
  baseline: readonly FingerprintedFinding[];
  comparableRuleIds: ReadonlySet<string>;
  current: readonly FingerprintedFinding[];
  currentPaths: ReadonlySet<string>;
  unreviewedPaths: ReadonlySet<string>;
}

function byLocation(
  left: FingerprintedFinding,
  right: FingerprintedFinding,
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

function sameFileKey(finding: FingerprintedFinding): string {
  return [finding.filePath, finding.ruleId, finding.fingerprint].join("\n");
}

function anyFileKey(finding: FingerprintedFinding): string {
  return [finding.ruleId, finding.fingerprint].join("\n");
}

function groupBy(
  findings: readonly FingerprintedFinding[],
  key: (finding: FingerprintedFinding) => string,
): Map<string, FingerprintedFinding[]> {
  const groups = new Map<string, FingerprintedFinding[]>();
  for (const finding of findings) {
    const group = groups.get(key(finding));
    if (group === undefined) {
      groups.set(key(finding), [finding]);
    } else {
      group.push(finding);
    }
  }
  return groups;
}

function matchInSameFile(
  current: readonly FingerprintedFinding[],
  baseline: readonly FingerprintedFinding[],
): {
  persisting: PersistingFinding[];
  unmatchedBaseline: FingerprintedFinding[];
  unmatchedCurrent: FingerprintedFinding[];
} {
  const baselineByKey = groupBy(baseline, sameFileKey);
  const persisting: PersistingFinding[] = [];
  const unmatchedCurrent: FingerprintedFinding[] = [];
  for (const finding of current) {
    const match = baselineByKey.get(sameFileKey(finding))?.shift();
    if (match === undefined) {
      unmatchedCurrent.push(finding);
    } else {
      persisting.push({ baseline: match, current: finding, moved: false });
    }
  }
  return {
    persisting,
    unmatchedBaseline: [...baselineByKey.values()].flat().sort(byLocation),
    unmatchedCurrent,
  };
}

function matchRenamed(
  unmatchedCurrent: readonly FingerprintedFinding[],
  unmatchedBaseline: readonly FingerprintedFinding[],
  currentPaths: ReadonlySet<string>,
): PersistingFinding[] {
  const removedFileBaseline = groupBy(
    unmatchedBaseline.filter((finding) => !currentPaths.has(finding.filePath)),
    anyFileKey,
  );
  const moved: PersistingFinding[] = [];
  for (const [key, candidates] of groupBy(unmatchedCurrent, anyFileKey)) {
    const removed = removedFileBaseline.get(key);
    if (
      removed === undefined ||
      candidates.length !== 1 ||
      removed.length !== 1
    ) {
      continue;
    }
    const [current] = candidates;
    const [baseline] = removed;
    if (current === undefined || baseline === undefined) continue;
    moved.push({ baseline, current, moved: true });
  }
  return moved;
}

function compareFindings(input: FindingComparisonInput): FindingComparison {
  const current = input.current
    .filter((finding) => input.comparableRuleIds.has(finding.ruleId))
    .sort(byLocation);
  const baseline = input.baseline
    .filter(
      (finding) =>
        input.comparableRuleIds.has(finding.ruleId) &&
        !input.unreviewedPaths.has(finding.filePath),
    )
    .sort(byLocation);

  const sameFile = matchInSameFile(current, baseline);
  const renamed = matchRenamed(
    sameFile.unmatchedCurrent,
    sameFile.unmatchedBaseline,
    input.currentPaths,
  );
  const matched = new Set(
    renamed.flatMap((pair) => [pair.current, pair.baseline]),
  );

  return {
    new: sameFile.unmatchedCurrent.filter((finding) => !matched.has(finding)),
    notComparable:
      input.current.length +
      input.baseline.length -
      current.length -
      baseline.length,
    persisting: [...sameFile.persisting, ...renamed].sort((left, right) =>
      byLocation(left.current, right.current),
    ),
    resolved: sameFile.unmatchedBaseline
      .filter((finding) => !matched.has(finding))
      .map((finding) => ({
        fileRemoved: !input.currentPaths.has(finding.filePath),
        finding,
      })),
  };
}

export { compareFindings };
export type {
  FindingComparison,
  FindingComparisonInput,
  FingerprintedFinding,
  PersistingFinding,
  ResolvedFinding,
};
