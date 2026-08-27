import { pino } from "pino";

import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ToolCall } from "~/domain/types/llm.types";
import type { ReviewContext } from "~/domain/types/pipeline.types";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
import { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

const CORE_FILE = "src/utils/calc.ts";
const DEP_A = "src/a.ts";
const DEP_B = "src/b.ts";
const DEP_C = "src/c.ts";

const FILES: Record<string, string> = {
  [CORE_FILE]: [
    `// Changed: subtract instead of add`,
    `export function add(a: number, b: number): number {`,
    `  return a - b; // BUG: was a + b`,
    `}`,
  ].join("\n"),
  [DEP_A]: [
    `import { add } from "./utils/calc";`,
    `export function sumA(x: number): number { return add(x, 10); }`,
  ].join("\n"),
  [DEP_B]: [
    `import { add } from "./utils/calc";`,
    `export function sumB(x: number): number { return add(x, 20); }`,
  ].join("\n"),
  [DEP_C]: [
    `import { add } from "./utils/calc";`,
    `export function sumC(x: number): number { return add(x, 30); }`,
  ].join("\n"),
};

function buildBulkDepLines(
  filePath: string,
  count: number,
): ParsedFileDiff["lines"] {
  const header = `@@ -1,${count.toString()} +1,${count.toString()} @@`;
  const lines: ParsedFileDiff["lines"] = [
    {
      content: `import { add } from "./utils/calc";`,
      hunkHeader: header,
      newLine: 1,
      type: "context",
    },
  ];
  for (let i = 0; i < count; i += 1) {
    lines.push({
      content: `  // touched line ${i.toString()} in ${filePath} for cross-file acceptance`,
      hunkHeader: header,
      newLine: i + 2,
      type: "added",
    });
  }
  return lines;
}

function buildFakeDiffs(): ParsedFileDiff[] {
  return [
    {
      lines: [
        {
          content: "export function add(a: number, b: number): number {",
          hunkHeader: "@@ -1,3 +1,3 @@",
          newLine: 2,
          type: "context",
        },
        {
          content: "  return a - b; // BUG: was a + b",
          hunkHeader: "@@ -1,3 +1,3 @@",
          newLine: 3,
          type: "added",
        },
        {
          content: "  return a + b;",
          hunkHeader: "@@ -1,3 +1,3 @@",
          oldLine: 3,
          type: "removed",
        },
      ],
      newPath: CORE_FILE,
      oldPath: CORE_FILE,
    },
    { lines: buildBulkDepLines(DEP_A, 50), newPath: DEP_A, oldPath: DEP_A },
    { lines: buildBulkDepLines(DEP_B, 50), newPath: DEP_B, oldPath: DEP_B },
    { lines: buildBulkDepLines(DEP_C, 50), newPath: DEP_C, oldPath: DEP_C },
  ];
}

function buildInlineOverlayView(): IOverlayView {
  return {
    createToolExecutor(): (call: ToolCall) => Promise<string> {
      return (call: ToolCall): Promise<string> => {
        if (call.name === "read_file") {
          const path = call.arguments["path"];
          if (typeof path === "string" && FILES[path] !== undefined) {
            return Promise.resolve(FILES[path]);
          }
          return Promise.resolve(
            `File not found: ${String(call.arguments["path"])}`,
          );
        }
        if (call.name === "search_content") {
          const pattern = call.arguments["pattern"];
          if (typeof pattern === "string" && pattern.includes("add(")) {
            return Promise.resolve(
              [DEP_A, DEP_B, DEP_C]
                .map((f) => `${f}:1: import { add } from "./utils/calc";`)
                .join("\n"),
            );
          }
          return Promise.resolve("");
        }
        if (call.name === "list_files") {
          return Promise.resolve(Object.keys(FILES).join("\n"));
        }
        return Promise.resolve("");
      };
    },
    readFile(path: string): Promise<string> {
      if (FILES[path] !== undefined) return Promise.resolve(FILES[path]);
      return Promise.resolve(`File not found: ${path}`);
    },
    readFileAtBaseline(path: string): Promise<string> {
      if (FILES[path] !== undefined) return Promise.resolve(FILES[path]);
      return Promise.resolve(`File not found: ${path}`);
    },
    searchContent(pattern: string): Promise<string> {
      if (pattern.includes("add(")) {
        return Promise.resolve(
          [DEP_A, DEP_B, DEP_C]
            .map((f) => `${f}:1: import { add } from "./utils/calc";`)
            .join("\n"),
        );
      }
      return Promise.resolve(`No matches found for: ${pattern}`);
    },
  };
}

function buildContext(
  diffs: ParsedFileDiff[],
  models: { review: string; triage: string },
): ReviewContext {
  return {
    diffs,
    isIncremental: false,
    mrIid: 999,
    mrInfo: {
      description: "Change add() to subtract in calc.ts",
      iid: 999,
      projectId: 1,
      sourceBranch: "fix/calc",
      targetBranch: "main",
      title: "chore: rename add to subtract in calc",
    },
    overlayView: buildInlineOverlayView(),
    previousFindings: [],
    projectId: 1,
    reviewConfig: createMockReviewConfig({
      modelOverrides: { review: true, triage: true },
      models: { premium: null, review: models.review, triage: models.triage },
    }),
    reviewRunId: "acceptance-run",
    toolCallCache: new Map(),
    versions: { baseSha: "base", headSha: "head", startSha: "start" },
  };
}

async function main(): Promise<void> {
  const logger = pino({ level: "debug" });

  const llmConfig = new LlmConfig();
  let llm: OllamaClient | OpenRouterClient;
  let reviewModel: string;
  let triageModel: string;
  if (llmConfig.envs.LLM_PROVIDER === "ollama") {
    llm = new OllamaClient(llmConfig, logger);
    reviewModel = llmConfig.envs.OLLAMA_MODEL;
    triageModel = llmConfig.envs.OLLAMA_TRIAGE_MODEL;
  } else {
    const openRouterConfig = new OpenRouterConfig();
    llm = new OpenRouterClient(openRouterConfig, logger);
    reviewModel = openRouterConfig.envs.OPENROUTER_MODEL;
    triageModel = openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL;
  }

  const pass = new CrossFilePass(llm, logger);
  const diffs = buildFakeDiffs();
  const context = buildContext(diffs, {
    review: reviewModel,
    triage: triageModel,
  });

  process.stderr.write(
    `\n[ACCEPTANCE] Provider=${llmConfig.envs.LLM_PROVIDER} review=${reviewModel} triage=${triageModel}\n`,
  );
  process.stderr.write(
    `[ACCEPTANCE] Running CrossFilePass with ${diffs.length.toString()} files (1 core + 3 dependents)...\n`,
  );

  const priorResults = new Map<
    string,
    Awaited<ReturnType<CrossFilePass["execute"]>>
  >([
    [
      "file-review",
      {
        findings: [
          {
            category: "bug",
            comment:
              "Critical behaviour change in add(): subtraction instead of addition affects every caller.",
            confidence: 0.95,
            filePath: CORE_FILE,
            lineNumber: 3,
            lineType: "added",
            model: "acceptance",
            passName: "file-review",
            severity: "critical",
          },
        ],
        metadata: {},
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      },
    ],
  ]);

  const result = await pass.execute(context, priorResults);

  const skipped = (result.metadata as { skipped?: string }).skipped;
  const passActuallyRan = skipped === undefined;
  const findingCount = result.findings.length;
  const allText = result.findings.map((f) => f.comment).join("\n");
  const depPaths = [DEP_A, DEP_B, DEP_C];
  const catchesDependents =
    result.findings.some((f) =>
      depPaths.some((p) => f.comment.includes(p) || f.filePath === p),
    ) || depPaths.some((p) => allText.includes(p));

  process.stderr.write(`[ACCEPTANCE] Pass ran: ${String(passActuallyRan)}\n`);
  if (!passActuallyRan) {
    process.stderr.write(
      `[ACCEPTANCE] Pass early-exited with metadata.skipped=${String(skipped)}\n`,
    );
  }
  process.stderr.write(`[ACCEPTANCE] Finding count: ${findingCount}\n`);
  process.stderr.write(
    `[ACCEPTANCE] Caught dependency chain: ${String(catchesDependents)}\n`,
  );

  if (findingCount > 0) {
    process.stderr.write(
      `[ACCEPTANCE] Findings:\n${result.findings
        .map(
          (f) =>
            `  [${f.severity}] ${f.filePath}:${f.lineNumber} — ${f.comment.slice(0, 120)}`,
        )
        .join("\n")}\n`,
    );
  }

  if (!passActuallyRan) {
    process.stderr.write(
      `[ACCEPTANCE] FAIL: Cross-file pass did not even run (early exit).\n`,
    );
    process.exit(1);
  }

  if (!catchesDependents) {
    process.stderr.write(
      `[ACCEPTANCE] FAIL: Cross-file pass did not mention dependent files (${depPaths.join(", ")})\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`[ACCEPTANCE] PASS: Dependency chain detected.\n\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[ACCEPTANCE] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
