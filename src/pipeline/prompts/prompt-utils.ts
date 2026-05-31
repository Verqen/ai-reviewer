function injectProjectRules(prompt: string, rules: string): string {
  return `${prompt}\n\nProject rules:\n<project_rules>\n${rules}\n</project_rules>`;
}

function injectPathRules(prompt: string, pathRules: string): string {
  return `${prompt}\n\nPath rules:\n<path_rules>\n${pathRules}\n</path_rules>`;
}

function buildJsonOutputInstructions(schema: string): string {
  return [
    "Return valid JSON only (no markdown, no code fences, no commentary before or after).",
    "Use the exact field names and snake_case casing shown in the schema.",
    "Do not invent fields that are not in the schema; do not omit required fields.",
    "For optional fields with unknown values, use null (not empty string), unless the schema documents an empty-string semantics for that field.",
    `Schema:\n${schema}`,
  ].join("\n");
}

export { buildJsonOutputInstructions, injectPathRules, injectProjectRules };
