import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ToolCall } from "~/domain/types/llm.types";
import type { LineType } from "~/domain/types/review.types";

import { resolveDiffHunkForAnchor } from "./resolve-diff-hunk-for-anchor";

const DEV_NULL_PATH = "/dev/null";
const LINE_TYPES = ["added", "context", "removed"] as const;

function normalizeComparableRepoPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function isAnchorLineType(value: unknown): value is LineType {
  return (
    typeof value === "string" &&
    LINE_TYPES.some((candidate) => candidate === value)
  );
}

function buildInvalidPayload(detail: string): string {
  return `Invalid arguments for diff_hunk: ${detail}`;
}

function truncateAtCap(payload: string, maxChars: number): string {
  if (payload.length <= maxChars) {
    return payload;
  }
  return `${payload.slice(0, maxChars)}\n[truncation:tool_response_chars] limit=${String(maxChars)} total=${String(payload.length)}`;
}

async function executeDiffHunkTool(params: {
  call: ToolCall;
  maxToolChars: number;
  overlay: Pick<IOverlayView, "readFile" | "readFileAtBaseline">;
  parsed: ParsedFileDiff;
}): Promise<string> {
  const record = params.call.arguments;
  const pathArg = record["path"];
  if (typeof pathArg !== "string" || pathArg.trim().length === 0) {
    return buildInvalidPayload('Field "path" must be a non-empty string.');
  }
  const pathComparable = normalizeComparableRepoPath(pathArg);
  const expectedComparable = normalizeComparableRepoPath(params.parsed.newPath);
  if (pathComparable !== expectedComparable) {
    return buildInvalidPayload(
      `path must equal the MR newPath (${params.parsed.newPath}).`,
    );
  }
  const lineNumberRaw = record["line_number"];
  if (
    typeof lineNumberRaw !== "number" ||
    !Number.isInteger(lineNumberRaw) ||
    lineNumberRaw <= 0
  ) {
    return buildInvalidPayload(
      'Field "line_number" must be a positive integer.',
    );
  }
  const lineTypeRaw = record["line_type"];
  if (!isAnchorLineType(lineTypeRaw)) {
    return buildInvalidPayload(
      'Field "line_type" must be one of: added, removed, context.',
    );
  }
  let contextLines: number | undefined;
  const contextRaw = record["context_lines"];
  if (Object.hasOwn(record, "context_lines")) {
    if (
      typeof contextRaw !== "number" ||
      !Number.isInteger(contextRaw) ||
      contextRaw < 0
    ) {
      return buildInvalidPayload(
        'Field "context_lines" must be a non-negative integer when provided.',
      );
    }
    contextLines = contextRaw;
  }
  const anchorResolution = resolveDiffHunkForAnchor(
    params.parsed,
    lineNumberRaw,
    lineTypeRaw,
    contextLines !== undefined ? { contextLines } : undefined,
  );
  if (anchorResolution.kind === "error") {
    return anchorResolution.error;
  }
  const { lineRanges } = anchorResolution;
  const hasOldBaselineFile = params.parsed.oldPath !== DEV_NULL_PATH;
  const hasNewHeadFile = params.parsed.newPath !== DEV_NULL_PATH;
  const baselineRefPathLabel = hasOldBaselineFile
    ? params.parsed.oldPath
    : "(none — new file)";
  const headMrPathLabel = hasNewHeadFile
    ? params.parsed.newPath
    : "(none — deletion)";
  const beforeLabel = `[before] baseline ref path=${baselineRefPathLabel}`;
  const afterLabel = `[after] MR head path=${headMrPathLabel}`;
  const beforeSlicePromise: Promise<string> = hasOldBaselineFile
    ? params.overlay.readFileAtBaseline(
        params.parsed.oldPath,
        lineRanges.oldStartInclusive,
        lineRanges.oldEndInclusive,
      )
    : Promise.resolve("(file did not exist at baseline — new file in MR.)");
  const afterSlicePromise: Promise<string> = hasNewHeadFile
    ? params.overlay.readFile(
        params.parsed.newPath,
        lineRanges.headNewStartInclusive,
        lineRanges.headNewEndInclusive,
      )
    : Promise.resolve("(file removed in MR — no corresponding head blob.)");
  const [beforeBody, afterBody] = await Promise.all([
    beforeSlicePromise,
    afterSlicePromise,
  ]);
  const header = `[diff_hunk] path=${params.parsed.newPath} hunk=${anchorResolution.hunkHeader.trim()}`;
  const metaBlock = [
    `anchor_used line_type=${lineTypeRaw} line_number=${String(lineNumberRaw)}`,
    `baseline_slice lines=${String(lineRanges.oldStartInclusive)}-${String(lineRanges.oldEndInclusive)} path=${baselineRefPathLabel}`,
    `head_slice lines=${String(lineRanges.headNewStartInclusive)}-${String(lineRanges.headNewEndInclusive)} path=${headMrPathLabel}`,
  ].join("\n");
  const assembled = `${header}\n${metaBlock}\n\n${beforeLabel}\n${beforeBody}\n\n${afterLabel}\n${afterBody}`;
  return truncateAtCap(assembled, params.maxToolChars);
}

export { executeDiffHunkTool, normalizeComparableRepoPath };
