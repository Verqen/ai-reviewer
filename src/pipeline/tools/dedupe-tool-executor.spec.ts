import { describe, expect, it, vi } from "vitest";

import type { ToolCall } from "~/domain/types/llm.types";

import { createDedupeToolExecutor } from "./dedupe-tool-executor";

function buildReadFileCall(path: string): ToolCall {
  return {
    arguments: { path },
    id: "tool-call-id",
    name: "read_file",
  };
}

describe("createDedupeToolExecutor", () => {
  it("calls delegate only once for repeated read_file arguments", async () => {
    const delegate = vi.fn(
      (_call: ToolCall): Promise<string> => Promise.resolve("file-content")
    );
    const executeToolCall = createDedupeToolExecutor(delegate, new Map());
    const toolCall = buildReadFileCall("src/service.ts");
    const firstResult = await executeToolCall(toolCall);
    const secondResult = await executeToolCall(toolCall);
    expect(firstResult).toBe("file-content");
    expect(secondResult).toBe("file-content");
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight repeated read_file calls", async () => {
    const delegate = vi.fn(
      (_call: ToolCall): Promise<string> =>
        new Promise((resolve: (value: string) => void) => {
          setTimeout(() => resolve("shared-content"), 5);
        })
    );
    const executeToolCall = createDedupeToolExecutor(delegate, new Map());
    const toolCall = buildReadFileCall("src/shared.ts");
    const [firstResult, secondResult] = await Promise.all([
      executeToolCall(toolCall),
      executeToolCall(toolCall),
    ]);
    expect(firstResult).toBe("shared-content");
    expect(secondResult).toBe("shared-content");
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});
