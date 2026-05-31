import { describe, expect, it } from "vitest";

import { buildCommentSystemPrompt } from "./review.prompt";

describe("buildCommentSystemPrompt", () => {
  it("prioritizes DDD, Hexagonal architecture and strict TypeScript", () => {
    const prompt = buildCommentSystemPrompt(null, null);
    expect(prompt).toContain("Prioritize DDD and Hexagonal Architecture");
    expect(prompt).toContain("strict TypeScript type safety");
    expect(prompt).toContain("project architectural consistency");
  });

  it("mentions balanced strictness for severity", () => {
    const prompt = buildCommentSystemPrompt(null, null);
    expect(prompt).toContain("use balanced strictness");
    expect(prompt).toContain("concrete risk to behavior");
  });

  it("keeps markdown format and forces output language (default English)", () => {
    const prompt = buildCommentSystemPrompt(null, null);
    expect(prompt).toContain("Respond in plain markdown, not JSON");
    expect(prompt).toContain("You MUST write your response in English.");
  });

  it("respects explicit language override", () => {
    const prompt = buildCommentSystemPrompt(null, null, {
      language: "Russian",
      toolsAvailable: false,
    });
    expect(prompt).toContain("You MUST write your response in Russian.");
  });

  it("injects project rules when projectRules is set", () => {
    const prompt = buildCommentSystemPrompt(
      "Prefer pure domain services",
      null,
    );
    expect(prompt).toContain("<project_rules>");
    expect(prompt).toContain("Prefer pure domain services");
  });

  it("injects path rules when pathRules is set", () => {
    const prompt = buildCommentSystemPrompt(null, "Only under src/**");
    expect(prompt).toContain("<path_rules>");
    expect(prompt).toContain("Only under src/**");
  });

  it("when tools are available, caps rounds and requires final markdown without tool calls", () => {
    const prompt = buildCommentSystemPrompt(null, null, {
      maxToolRounds: 4,
      toolsAvailable: true,
    });
    expect(prompt).toContain("max 4 tool rounds");
    expect(prompt).toContain("Do not loop on tools");
    expect(prompt).toContain("no tool calls");
    expect(prompt).toContain(
      "Stop calling tools as soon as the diff and tool outputs are enough to answer",
    );
  });
});
