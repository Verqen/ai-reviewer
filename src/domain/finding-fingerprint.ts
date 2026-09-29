import { createHash } from "node:crypto";

const FINGERPRINT_SCHEME = "v1";
const FINGERPRINT_HEX_LENGTH = 32;

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function fingerprintFinding(
  repoId: number,
  ruleId: string,
  lineText: string,
): string {
  return createHash("sha256")
    .update(
      [
        FINGERPRINT_SCHEME,
        String(repoId),
        ruleId,
        normalizeLine(lineText),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LENGTH);
}

export { fingerprintFinding, normalizeLine };
