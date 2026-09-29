import { describe, expect, it } from "vitest";

import type { ILlmClient } from "~/domain/ports/llm.port";
import type { LlmOptions, LlmResponse } from "~/domain/types/llm.types";
import {
  createReproducibleLlm,
  UnpinnedModelError,
} from "~/review/reproducible-llm";

const MODELS = { review: "vendor/review", triage: "vendor/triage" };
const PINS = { "vendor/review": "vendor-a", "vendor/triage": "vendor-b" };

function recordingLlm(): ILlmClient & { options: (LlmOptions | undefined)[] } {
  const reply: LlmResponse = {
    content: "",
    toolCalls: [],
    usage: { completionTokens: 0, promptTokens: 0 },
  };
  const llm = {
    chatCompletion(_messages: unknown, options?: LlmOptions) {
      llm.options.push(options);
      return Promise.resolve(reply);
    },
    chatCompletionWithTools(
      _messages: unknown,
      _tools: unknown,
      _executor: unknown,
      options?: LlmOptions,
    ) {
      llm.options.push(options);
      return Promise.resolve(reply);
    },
    options: [] as (LlmOptions | undefined)[],
  };
  return llm;
}

describe("createReproducibleLlm", () => {
  it("pins temperature, turns reasoning off and routes to the pinned provider", async () => {
    const inner = recordingLlm();
    const llm = createReproducibleLlm(inner, MODELS, PINS);

    await llm.chatCompletion([], {
      model: "vendor/triage",
      reasoning: { effort: "low" },
      temperature: 0.7,
    });
    await llm.chatCompletionWithTools([], [], () => Promise.resolve(""), {
      model: "vendor/review",
    });

    expect(inner.options).toEqual([
      {
        model: "vendor/triage",
        provider: { allowFallbacks: false, order: ["vendor-b"] },
        reasoning: undefined,
        temperature: 0,
      },
      {
        model: "vendor/review",
        provider: { allowFallbacks: false, order: ["vendor-a"] },
        reasoning: undefined,
        temperature: 0,
      },
    ]);
  });

  it("uses the review model when a call names no model", async () => {
    const inner = recordingLlm();

    await createReproducibleLlm(inner, MODELS, PINS).chatCompletion([]);

    expect(inner.options[0]).toMatchObject({
      model: "vendor/review",
      provider: { order: ["vendor-a"] },
    });
  });

  it("refuses models without a pinned provider", () => {
    expect(() =>
      createReproducibleLlm(recordingLlm(), MODELS, {
        "vendor/review": "vendor-a",
      }),
    ).toThrow(UnpinnedModelError);
  });

  it("refuses a call to a model that was not pinned", async () => {
    const llm = createReproducibleLlm(recordingLlm(), MODELS, PINS);

    await expect(
      llm.chatCompletion([], { model: "vendor/other" }),
    ).rejects.toThrow(UnpinnedModelError);
  });

  it("adds no provider routing when there are no pins", async () => {
    const inner = recordingLlm();

    await createReproducibleLlm(inner, MODELS, null).chatCompletion([]);

    expect(inner.options[0]).not.toHaveProperty("provider");
    expect(inner.options[0]).toMatchObject({ temperature: 0 });
  });
});
