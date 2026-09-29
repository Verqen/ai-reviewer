import type { FastifyBaseLogger } from "fastify";

import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { CostBudget } from "~/domain/cost-budget";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ToolCall } from "~/domain/types/llm.types";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
import { AggregationPass } from "~/pipeline/passes/aggregation.pass";
import { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
import { FileReviewPass } from "~/pipeline/passes/file-review.pass";
import { applyTriageFilter, TriagePass } from "~/pipeline/passes/triage.pass";

interface ReviewModels {
  review: string;
  triage: string;
}

interface ReviewLlm {
  llm: ILlmClient;
  models: ReviewModels;
}

interface ReviewPassRun {
  passResults: Map<string, PassResult>;
  partial: boolean;
}

type OverlaySource = Pick<ICodeHost, "getFileContent" | "getFileTree">;

const noopDismissedPatternRepo: IDismissedPatternRepository = {
  create: () => Promise.reject(new Error("not supported in stateless review")),
  findByProject: () => Promise.resolve([]),
  findSimilar: () => Promise.resolve(undefined),
  incrementOccurrence: () => Promise.resolve(),
};

function createReviewLlm(logger: FastifyBaseLogger): ReviewLlm {
  const llmConfig = new LlmConfig();
  if (llmConfig.envs.LLM_PROVIDER === "ollama") {
    return {
      llm: new OllamaClient(llmConfig, logger),
      models: {
        review: llmConfig.envs.OLLAMA_MODEL,
        triage: llmConfig.envs.OLLAMA_TRIAGE_MODEL,
      },
    };
  }
  const openRouterConfig = new OpenRouterConfig();
  return {
    llm: new OpenRouterClient(openRouterConfig, logger),
    models: {
      review: openRouterConfig.envs.OPENROUTER_MODEL,
      triage: openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL,
    },
  };
}

function buildOverlay(
  codeHost: OverlaySource,
  projectId: number,
  headRef: string,
): IOverlayView {
  const cache = new Map<string, string | null>();
  let tree: string[] | null = null;

  async function read(path: string): Promise<string | null> {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    try {
      const content = await codeHost.getFileContent(projectId, headRef, path);
      cache.set(path, content);
      return content;
    } catch {
      cache.set(path, null);
      return null;
    }
  }

  async function listFiles(pattern: string): Promise<string> {
    if (tree === null) {
      const entries = await codeHost.getFileTree(projectId, headRef);
      tree = entries.map((entry) => entry.path);
    }
    const needle = pattern.replace(/\*/g, "");
    const filtered =
      needle.length > 0 ? tree.filter((p) => p.includes(needle)) : tree;
    return filtered.slice(0, 200).join("\n");
  }

  async function readBounded(path: string): Promise<string> {
    const content = await read(path);
    return content === null
      ? `File not found: ${path}`
      : content.slice(0, 6000);
  }

  return {
    createToolExecutor(): (call: ToolCall) => Promise<string> {
      return async (call: ToolCall): Promise<string> => {
        if (call.name === "read_file") {
          const path = call.arguments["path"];
          return typeof path === "string"
            ? readBounded(path)
            : "Invalid arguments: path required";
        }
        if (call.name === "list_files") {
          const pattern =
            typeof call.arguments["pattern"] === "string"
              ? call.arguments["pattern"]
              : "";
          return listFiles(pattern);
        }
        return Promise.resolve("Tool not available in this run.");
      };
    },
    readFile(path: string): Promise<string> {
      return readBounded(path);
    },
    readFileAtBaseline(path: string): Promise<string> {
      return readBounded(path);
    },
    searchContent(): Promise<string> {
      return Promise.resolve("No matches found.");
    },
  };
}

async function runReviewPasses(params: {
  context: ReviewContext;
  costBudget: CostBudget;
  llm: ILlmClient;
  logger: FastifyBaseLogger;
}): Promise<ReviewPassRun> {
  const { costBudget, llm, logger } = params;
  let context = params.context;
  const passResults = new Map<string, PassResult>();

  const triage = new TriagePass(llm, logger);
  const triageResult = await triage.execute(context, passResults);
  passResults.set("triage", triageResult);
  const triageMeta = triageResult.metadata;
  context = {
    ...context,
    diffs: applyTriageFilter(context.diffs, triageMeta.trivialKeys),
  };

  const fileReview = new FileReviewPass(llm, logger);
  passResults.set(
    "file-review",
    await fileReview.execute(context, passResults),
  );

  const partial = costBudget.isExhausted();
  if (partial) {
    logger.warn(
      {
        limitUsd: costBudget.limit,
        mrIid: context.mrIid,
        projectId: context.projectId,
        spentUsd: costBudget.spent,
      },
      "Per-scan cost ceiling reached: skipping cross-file pass, finalizing partial review",
    );
  } else {
    const crossFile = new CrossFilePass(llm, logger);
    passResults.set(
      "cross-file",
      await crossFile.execute(context, passResults),
    );
  }

  const aggregation = new AggregationPass(noopDismissedPatternRepo, logger, 3);
  passResults.set(
    "aggregation",
    await aggregation.execute(context, passResults),
  );

  return { partial, passResults };
}

export { buildOverlay, createReviewLlm, runReviewPasses };
export type { ReviewLlm, ReviewModels, ReviewPassRun };
