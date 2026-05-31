function collectLineNumberedMatches(text: string, pattern: string): string[] {
  const lines = text.split("\n");
  const matches: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.includes(pattern)) {
      matches.push(`${index + 1}:${line}`);
    }
  }
  return matches;
}

export { collectLineNumberedMatches };
