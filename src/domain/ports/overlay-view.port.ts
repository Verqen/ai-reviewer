import type { ToolCall } from "~/domain/types/llm.types";

interface IOverlayView {
  createToolExecutor(): (call: ToolCall) => Promise<string>;
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
  readFileAtBaseline(
    path: string,
    startLine?: number,
    endLine?: number
  ): Promise<string>;
  searchContent(pattern: string, glob?: string): Promise<string>;
}

export type { IOverlayView };
