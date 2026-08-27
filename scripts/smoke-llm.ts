import { pino } from "pino";

import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { ChatMessage, ToolDefinition } from "~/domain/types/llm.types";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";

interface ProbeResult {
  completionTokens: number;
  detail: string;
  durationMs: number;
  ok: boolean;
  promptTokens: number;
}

const FAKE_READ_FILE_TOOL: ToolDefinition = {
  description: "Read a file from the repository",
  name: "read_file",
  parameters: {
    properties: { path: { type: "string" } },
    required: ["path"],
    type: "object",
  },
};

async function probePlain(
  llm: ILlmClient,
  model: string,
): Promise<ProbeResult> {
  const messages: ChatMessage[] = [
    { content: "Say only the word OK.", role: "user" },
  ];
  const start = Date.now();
  try {
    const res = await llm.chatCompletion(messages, {
      maxTokens: 10,
      model,
      temperature: 0,
    });
    return {
      completionTokens: res.usage.completionTokens,
      detail: (res.content ?? "<null>").slice(0, 80),
      durationMs: Date.now() - start,
      ok: res.content !== null && res.content.trim().length > 0,
      promptTokens: res.usage.promptTokens,
    };
  } catch (err) {
    return {
      completionTokens: 0,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      durationMs: Date.now() - start,
      ok: false,
      promptTokens: 0,
    };
  }
}

async function probeJsonSchema(
  llm: ILlmClient,
  model: string,
): Promise<ProbeResult> {
  const messages: ChatMessage[] = [
    {
      content:
        "Return JSON with fields {answer: 'yes', confidence: 0.9}. Nothing else.",
      role: "user",
    },
  ];
  const start = Date.now();
  try {
    const res = await llm.chatCompletion(messages, {
      maxTokens: 60,
      model,
      responseSchema: {
        properties: {
          answer: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["answer", "confidence"],
        type: "object",
      },
      temperature: 0,
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(res.content ?? "");
    } catch {
      parsed = null;
    }
    const ok =
      parsed !== null &&
      typeof parsed === "object" &&
      "answer" in (parsed as Record<string, unknown>);
    return {
      completionTokens: res.usage.completionTokens,
      detail: (res.content ?? "<null>").slice(0, 100),
      durationMs: Date.now() - start,
      ok,
      promptTokens: res.usage.promptTokens,
    };
  } catch (err) {
    return {
      completionTokens: 0,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      durationMs: Date.now() - start,
      ok: false,
      promptTokens: 0,
    };
  }
}

async function probeToolCall(
  llm: ILlmClient,
  model: string,
): Promise<ProbeResult> {
  const messages: ChatMessage[] = [
    {
      content:
        "Call read_file with path='src/index.ts' once, then reply with the literal word DONE.",
      role: "user",
    },
  ];
  const start = Date.now();
  let toolCallCount = 0;
  try {
    const res = await llm.chatCompletionWithTools(
      messages,
      [FAKE_READ_FILE_TOOL],
      (call) => {
        toolCallCount += 1;
        if (call.name === "read_file") {
          return Promise.resolve("export const X = 1;");
        }
        return Promise.resolve("");
      },
      {
        maxTokens: 50,
        maxToolRounds: 2,
        model,
        temperature: 0,
      },
    );
    return {
      completionTokens: res.usage.completionTokens,
      detail: `${(res.content ?? "<null>").slice(0, 80)} | toolCalls=${String(toolCallCount)}`,
      durationMs: Date.now() - start,
      ok: res.content !== null && toolCallCount >= 1,
      promptTokens: res.usage.promptTokens,
    };
  } catch (err) {
    return {
      completionTokens: 0,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      durationMs: Date.now() - start,
      ok: false,
      promptTokens: 0,
    };
  }
}

function formatResult(label: string, model: string, r: ProbeResult): string {
  const status = r.ok ? "PASS" : "FAIL";
  return [
    `  ${label.padEnd(16)} model=${model.padEnd(35)} ${status}`,
    `    duration=${String(r.durationMs).padStart(6)}ms  promptTok=${String(r.promptTokens).padStart(5)}  completionTok=${String(r.completionTokens).padStart(4)}`,
    `    detail: ${r.detail}`,
  ].join("\n");
}

async function runSuite(
  llm: ILlmClient,
  models: { label: string; model: string }[],
): Promise<{ failures: number }> {
  let failures = 0;
  for (const { label, model } of models) {
    process.stderr.write(`\n[${label}] ${model}\n`);

    const plain = await probePlain(llm, model);
    process.stderr.write(`${formatResult("plain", model, plain)}\n`);
    if (!plain.ok) failures += 1;

    const json = await probeJsonSchema(llm, model);
    process.stderr.write(`${formatResult("json-schema", model, json)}\n`);
    if (!json.ok) failures += 1;

    const tools = await probeToolCall(llm, model);
    process.stderr.write(`${formatResult("tool-call", model, tools)}\n`);
    if (!tools.ok) failures += 1;
  }
  return { failures };
}

async function main(): Promise<void> {
  const logger = pino({ level: "warn" });
  const llmConfig = new LlmConfig();
  const provider = llmConfig.envs.LLM_PROVIDER;

  process.stderr.write(`\n[SMOKE] Provider = ${provider}\n`);

  let llm: ILlmClient;
  let reviewModel: string;
  let triageModel: string;

  if (provider === "ollama") {
    llm = new OllamaClient(llmConfig, logger);
    reviewModel = llmConfig.envs.OLLAMA_MODEL;
    triageModel = llmConfig.envs.OLLAMA_TRIAGE_MODEL;
  } else {
    const openRouterConfig = new OpenRouterConfig();
    llm = new OpenRouterClient(openRouterConfig, logger);
    reviewModel = openRouterConfig.envs.OPENROUTER_MODEL;
    triageModel = openRouterConfig.envs.OPENROUTER_TRIAGE_MODEL;
  }

  process.stderr.write(`[SMOKE] review-model = ${reviewModel}\n`);
  process.stderr.write(`[SMOKE] triage-model = ${triageModel}\n`);

  const targets =
    reviewModel === triageModel
      ? [{ label: "shared", model: reviewModel }]
      : [
          { label: "review", model: reviewModel },
          { label: "triage", model: triageModel },
        ];

  const { failures } = await runSuite(llm, targets);

  process.stderr.write(`\n[SMOKE] failures: ${String(failures)}\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[SMOKE] Fatal error: ${String(err)}\n`);
  process.exit(2);
});
