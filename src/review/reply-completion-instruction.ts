function buildReplyCompletionInstruction(language: string): string {
  return `Completion rule: When you have enough context, respond in ${language} markdown immediately without further tool calls. On your last allowed tool round, output only user-visible markdown (no tool calls). Do not run extra tool rounds if the diff and thread already answer the question.`;
}

export { buildReplyCompletionInstruction };
