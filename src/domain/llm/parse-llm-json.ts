const FENCED_JSON_REGEX = /```(?:json)?\s*\n([\s\S]*?)\n```/;

function extractFencedJson(text: string): string | null {
  const match = FENCED_JSON_REGEX.exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractOutermostBraces(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");

  let openChar: string;
  let closeChar: string;
  let startIdx: number;

  if (startObj === -1 && startArr === -1) return null;

  if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    openChar = "{";
    closeChar = "}";
    startIdx = startObj;
  } else {
    openChar = "[";
    closeChar = "]";
    startIdx = startArr;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;

    if (depth === 0) {
      return text.slice(startIdx, i + 1);
    }
  }

  return null;
}

function recoverTruncatedArrayJson(text: string): string | null {
  const arrayStart = text.indexOf("[");
  if (arrayStart === -1) return null;

  const objectKey = findKeyForArray(text, arrayStart);
  const completeObjects: string[] = [];

  let i = arrayStart + 1;
  while (i < text.length) {
    while (i < text.length && /\s|,/.test(text[i] ?? "")) i++;
    if (i >= text.length || text[i] === "]") break;
    if (text[i] !== "{") break;

    const objectEnd = findObjectEnd(text, i);
    if (objectEnd === -1) break;
    completeObjects.push(text.slice(i, objectEnd + 1));
    i = objectEnd + 1;
  }

  if (completeObjects.length === 0) return null;

  const arrayJson = `[${completeObjects.join(",")}]`;
  return objectKey === null
    ? arrayJson
    : `{${JSON.stringify(objectKey)}:${arrayJson}}`;
}

function findKeyForArray(text: string, arrayStart: number): string | null {
  const before = text.slice(0, arrayStart);
  const keyMatch = /"([^"]+)"\s*:\s*$/.exec(before);
  return keyMatch?.[1] ?? null;
}

function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseLlmJson(raw: string | null, fallback: string = "{}"): unknown {
  const content = raw ?? fallback;

  try {
    return JSON.parse(content);
  } catch {
    // direct parse failed
  }

  const fenced = extractFencedJson(content);
  if (fenced) {
    try {
      return JSON.parse(fenced);
    } catch {
      // fenced extraction failed
    }
  }

  const braceContent = extractOutermostBraces(content);
  if (braceContent) {
    try {
      return JSON.parse(braceContent);
    } catch {
      // brace extraction failed
    }
  }

  const candidates = [content, fenced ?? "", braceContent ?? ""].filter(
    (c) => c.length > 0
  );
  for (const candidate of candidates) {
    const recovered = recoverTruncatedArrayJson(candidate);
    if (recovered !== null) {
      try {
        return JSON.parse(recovered);
      } catch {
        // recovery parse failed
      }
    }
  }

  return JSON.parse(fallback);
}

export { parseLlmJson };
