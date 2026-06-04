import type { ToolCall } from "~/domain/types/llm.types";

function buildToolCallCacheKey(call: ToolCall): string {
  const sortedArgs = Object.keys(call.arguments)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = call.arguments[key];
      return acc;
    }, {});
  return `${call.name}:${JSON.stringify(sortedArgs)}`;
}

export { buildToolCallCacheKey };
