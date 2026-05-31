import type { ToolCall } from "~/domain/types/llm.types";

type ToolExecutor = (call: ToolCall) => Promise<string>;

function createDedupeToolExecutor(
  delegate: ToolExecutor,
  cache: Map<string, Promise<string>>,
): ToolExecutor {
  return async function executeWithDedupe(call: ToolCall): Promise<string> {
    const key = buildToolCallCacheKey(call);
    const cachedResult = cache.get(key);
    if (cachedResult) {
      return cachedResult;
    }
    const resultPromise = delegate(call).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, resultPromise);
    return resultPromise;
  };
}

function buildToolCallCacheKey(call: ToolCall): string {
  return `${call.name}:${toStableJson(call.arguments)}`;
}

function toStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => toStableJson(item)).join(",")}]`;
  }
  if (isObjectRecord(value)) {
    const sortedEntries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const serializedEntries = sortedEntries.map(
      ([key, entryValue]: [string, unknown]) =>
        `${JSON.stringify(key)}:${toStableJson(entryValue)}`,
    );
    return `{${serializedEntries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export { createDedupeToolExecutor };
