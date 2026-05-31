import type { IDocProvider } from "~/domain/ports/doc-provider.port";
import type { ToolCall, ToolDefinition } from "~/domain/types/llm.types";

const docQueryTool: ToolDefinition = {
  description:
    "Look up current documentation for a library/framework. Use when you need to verify API usage, check for breaking changes, or understand library-specific patterns. Always use for unfamiliar or complex API calls.",
  name: "query_library_docs",
  parameters: {
    properties: {
      library: {
        description:
          "Library/package name (e.g., 'fastify', 'zod', 'prisma', 'react')",
        type: "string",
      },
      topic: {
        description:
          "Specific API, method, or topic to look up (e.g., 'z.coerce validation', 'fastify hooks lifecycle', 'prisma transactions')",
        type: "string",
      },
    },
    required: ["library", "topic"],
    type: "object",
  },
};

async function executeDocTool(
  call: ToolCall,
  docProvider: IDocProvider,
): Promise<string> {
  const library = call.arguments["library"];
  const topic = call.arguments["topic"];

  if (typeof library !== "string" || typeof topic !== "string") {
    return "Invalid tool arguments: library and topic must be strings.";
  }

  const lib = await docProvider.resolveLibrary(library, topic);
  if (!lib) {
    return `No documentation found for "${library}".`;
  }

  const docs = await docProvider.queryDocs(lib.id, topic);
  return (
    docs ||
    `No relevant documentation found for "${library}" on topic "${topic}".`
  );
}

export { docQueryTool, executeDocTool };
