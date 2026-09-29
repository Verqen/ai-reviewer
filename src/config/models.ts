const OPENROUTER_REVIEW_MODEL = "anthropic/claude-sonnet-4.6";
const OPENROUTER_TRIAGE_MODEL = "minimax/minimax-m2.7";

const ORDER_RUN_MODEL = "qwen/qwen3-235b-a22b-2507";

const OPENROUTER_PINNED_PROVIDERS: Readonly<Record<string, string>> = {
  [ORDER_RUN_MODEL]: "novita/fp8",
};

const OLLAMA_MODEL = "qwen3:8b";
const OLLAMA_TRIAGE_MODEL = "qwen3:8b";

export {
  OPENROUTER_PINNED_PROVIDERS,
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
  OLLAMA_MODEL,
  OLLAMA_TRIAGE_MODEL,
  ORDER_RUN_MODEL,
};
