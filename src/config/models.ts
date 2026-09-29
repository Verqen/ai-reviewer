const OPENROUTER_REVIEW_MODEL = "anthropic/claude-sonnet-4.6";
const OPENROUTER_TRIAGE_MODEL = "minimax/minimax-m2.7";

const OPENROUTER_PINNED_PROVIDERS: Readonly<Record<string, string>> = {
  [OPENROUTER_REVIEW_MODEL]: "anthropic",
  [OPENROUTER_TRIAGE_MODEL]: "minimax/fp8",
  "deepseek/deepseek-chat": "deepinfra/fp4",
  "qwen/qwen3-235b-a22b-2507": "novita/fp8",
};

const OLLAMA_MODEL = "qwen3:8b";
const OLLAMA_TRIAGE_MODEL = "qwen3:8b";

export {
  OPENROUTER_PINNED_PROVIDERS,
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
  OLLAMA_MODEL,
  OLLAMA_TRIAGE_MODEL,
};
