import type { LineType } from "~/domain/types/review.types";

interface DiffLine {
  content: string;
  hunkHeader: string;
  newLine?: number | undefined;
  oldLine?: number | undefined;
  type: LineType;
}

interface ParsedFileDiff {
  lines: DiffLine[];
  newPath: string;
  oldPath: string;
}

export type { DiffLine, ParsedFileDiff };
