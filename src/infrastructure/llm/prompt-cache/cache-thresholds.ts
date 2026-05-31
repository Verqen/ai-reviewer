const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

function getCacheMinTokens(model: string): number | null {
  const m = model.toLowerCase();
  if (!m.includes("claude")) return null;
  if (m.includes("opus") || m.includes("haiku")) return 4096;
  if (m.includes("sonnet-4-6") || m.includes("sonnet-4.6")) return 2048;
  if (
    m.includes("sonnet-4-5") ||
    m.includes("sonnet-4.5") ||
    m.includes("3-5-sonnet") ||
    m.includes("3.5-sonnet")
  ) {
    return 1024;
  }
  if (m.includes("sonnet")) return 2048;
  return 4096;
}

export { CHARS_PER_TOKEN, estimateTokens, getCacheMinTokens, isClaudeModel };
