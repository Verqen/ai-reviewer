import { describe, expect, it } from "vitest";

import { parseLlmJson } from "./parse-llm-json";

describe("parseLlmJson", () => {
  it("parses valid JSON directly", () => {
    const result = parseLlmJson('{"score":42}');
    expect(result).toEqual({ score: 42 });
  });

  it("parses JSON wrapped in ```json fences", () => {
    const input = '```json\n{"comments":[]}\n```';
    const result = parseLlmJson(input);
    expect(result).toEqual({ comments: [] });
  });

  it("parses JSON wrapped in plain ``` fences", () => {
    const input = '```\n{"ok":true}\n```';
    const result = parseLlmJson(input);
    expect(result).toEqual({ ok: true });
  });

  it("falls back to fallback parameter on invalid JSON", () => {
    const result = parseLlmJson("not valid json", "{}");
    expect(result).toEqual({});
  });

  it("uses default fallback {} when no fallback provided and input is invalid", () => {
    const result = parseLlmJson("garbage");
    expect(result).toEqual({});
  });

  it("falls back to fallback when input is null", () => {
    const result = parseLlmJson(null, '{"default":true}');
    expect(result).toEqual({ default: true });
  });

  it("recovers complete objects from truncated array under a known key", () => {
    const input =
      '{ "results": [ { "hunk_id": 0, "verdict": "trivial" }, ' +
      '{ "hunk_id": 1, "verdict": "needs-review" }, ' +
      '{ "hunk_id": 2, "verdict": "tri';
    const result = parseLlmJson(input);
    expect(result).toEqual({
      results: [
        { hunk_id: 0, verdict: "trivial" },
        { hunk_id: 1, verdict: "needs-review" },
      ],
    });
  });

  it("recovers complete objects from truncated array wrapped in fences", () => {
    const input =
      '```json\n{ "results": [ { "hunk_id": 0, "verdict": "trivial" }, ' +
      '{ "hunk_id": 1, "ver';
    const result = parseLlmJson(input);
    expect(result).toEqual({
      results: [{ hunk_id: 0, verdict: "trivial" }],
    });
  });

  it("returns fallback when truncated input has zero complete objects", () => {
    const input = '{ "results": [ { "hunk_id": 0, "verdict": "tri';
    const result = parseLlmJson(input);
    expect(result).toEqual({});
  });

  it("uses default fallback {} when input is null and no fallback provided", () => {
    const result = parseLlmJson(null);
    expect(result).toEqual({});
  });

  it("parses nested JSON object correctly", () => {
    const input = '{"a":{"b":{"c":1}}}';
    expect(parseLlmJson(input)).toEqual({ a: { b: { c: 1 } } });
  });

  it("falls back to fallback on empty string", () => {
    const result = parseLlmJson("", '{"empty":true}');
    expect(result).toEqual({ empty: true });
  });

  it("parses JSON array", () => {
    const result = parseLlmJson("[1,2,3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("strips only outer fences, leaving inner content intact", () => {
    const inner = '{"code":"```js\\nconsole.log()\\n```"}';
    const input = `\`\`\`json\n${inner}\n\`\`\``;
    const result = parseLlmJson(input) as Record<string, unknown>;
    expect(result["code"]).toContain("```js");
  });

  it("extracts JSON from preamble text + fenced block", () => {
    const input =
      'Based on my review of the code, here are my findings:\n\n```json\n{"findings":[{"file":"a.ts"}]}\n```';
    expect(parseLlmJson(input)).toEqual({
      findings: [{ file: "a.ts" }],
    });
  });

  it("extracts JSON from preamble text + unfenced object", () => {
    const input =
      'Here is my analysis:\n\n{"summary":"looks good","comments":[]}';
    expect(parseLlmJson(input)).toEqual({
      comments: [],
      summary: "looks good",
    });
  });

  it("extracts JSON when postamble text follows", () => {
    const input = '{"findings":[]}\n\nLet me know if you need more details.';
    expect(parseLlmJson(input)).toEqual({ findings: [] });
  });

  it("extracts JSON with both preamble and postamble", () => {
    const input = 'Review complete.\n\n{"score":95}\n\nHope this helps!';
    expect(parseLlmJson(input)).toEqual({ score: 95 });
  });

  it("prefers fenced JSON over unfenced when both present", () => {
    const input =
      'Some text with {bad:json} here\n\n```json\n{"good":"json"}\n```';
    expect(parseLlmJson(input)).toEqual({ good: "json" });
  });

  it("handles nested braces in unfenced extraction", () => {
    const input = 'Result:\n{"a":{"b":{"c":[1,2,3]}},"d":"e"}';
    expect(parseLlmJson(input)).toEqual({
      a: { b: { c: [1, 2, 3] } },
      d: "e",
    });
  });

  it("handles escaped quotes inside JSON strings during brace matching", () => {
    const input = 'Output:\n{"msg":"she said \\"hello\\"","ok":true}';
    expect(parseLlmJson(input)).toEqual({
      msg: 'she said "hello"',
      ok: true,
    });
  });

  it("extracts JSON array from preamble text", () => {
    const input = "Here are the items:\n[1,2,3]";
    expect(parseLlmJson(input)).toEqual([1, 2, 3]);
  });
});
