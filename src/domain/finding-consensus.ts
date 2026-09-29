interface ConsensusCandidate {
  filePath: string;
  fingerprint: string;
  line: number;
  ruleId: string;
}

class InvalidQuorumError extends Error {
  override readonly name = "InvalidQuorumError";

  constructor(
    readonly quorum: number,
    readonly passes: number,
  ) {
    super(
      `Quorum ${String(quorum)} is not a whole number between 1 and ${String(passes)} passes`,
    );
  }
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function byLocation(
  left: ConsensusCandidate,
  right: ConsensusCandidate,
): number {
  return (
    compareCodePoints(left.filePath, right.filePath) ||
    left.line - right.line ||
    compareCodePoints(left.ruleId, right.ruleId)
  );
}

function consensusKey(finding: ConsensusCandidate): string {
  return [finding.filePath, finding.ruleId, finding.fingerprint].join("\n");
}

function groupPass<T extends ConsensusCandidate>(
  findings: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const finding of findings) {
    const group = groups.get(consensusKey(finding));
    if (group === undefined) {
      groups.set(consensusKey(finding), [finding]);
    } else {
      group.push(finding);
    }
  }
  return groups;
}

function selectConsensusFindings<T extends ConsensusCandidate>(
  passes: readonly (readonly T[])[],
  quorum: number,
): T[] {
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > passes.length) {
    throw new InvalidQuorumError(quorum, passes.length);
  }
  const grouped = passes.map((pass) => groupPass(pass));
  const keys = new Set(grouped.flatMap((groups) => [...groups.keys()]));
  const selected: T[] = [];
  for (const key of keys) {
    const occurrences = grouped
      .map((groups) => [...(groups.get(key) ?? [])].sort(byLocation))
      .sort((left, right) => right.length - left.length);
    const agreed = occurrences[quorum - 1]?.length ?? 0;
    selected.push(...(occurrences[0] ?? []).slice(0, agreed));
  }
  return selected.sort(byLocation);
}

export { InvalidQuorumError, selectConsensusFindings };
export type { ConsensusCandidate };
