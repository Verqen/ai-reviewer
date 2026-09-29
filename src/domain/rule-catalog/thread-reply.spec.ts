import { describe, expect, it } from "vitest";

import {
  buildFindingThreadReply,
  buildMentionReply,
} from "~/domain/rule-catalog/thread-reply";

describe("thread replies", () => {
  it("answers a question on a finding with the fixed rule text", () => {
    expect(
      buildFindingThreadReply("R-013", "https://rules.example.com/rules"),
    ).toBe(
      "AI Reviewer is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013: A function or value is referenced in a file where it is neither declared nor imported. https://rules.example.com/rules#R-013",
    );
  });

  it("omits the link when no catalog url is configured", () => {
    expect(buildFindingThreadReply("R-013", undefined)).toBe(
      "AI Reviewer is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013: A function or value is referenced in a file where it is neither declared nor imported.",
    );
  });

  it("states the given product name in a finding reply", () => {
    expect(
      buildFindingThreadReply("R-013", undefined, "Acme").startsWith(
        "Acme is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013:",
      ),
    ).toBe(true);
  });

  it("uses the default product name for an empty or blank name", () => {
    expect(buildMentionReply(undefined, "")).toBe(buildMentionReply(undefined));
    expect(buildFindingThreadReply("R-013", undefined, "  ")).toBe(
      buildFindingThreadReply("R-013", undefined),
    );
  });

  it("states the given product name in a mention reply", () => {
    expect(buildMentionReply(undefined, "Acme")).toBe(
      "Acme is an automated check against a published rule catalog and does not answer questions.",
    );
  });

  it("returns an empty reply for a finding without a catalog rule", () => {
    expect(
      buildFindingThreadReply(undefined, "https://rules.example.com/rules"),
    ).toBe("");
    expect(
      buildFindingThreadReply(null, "https://rules.example.com/rules"),
    ).toBe("");
    expect(
      buildFindingThreadReply("R-999", "https://rules.example.com/rules"),
    ).toBe("");
  });

  it("answers a mention with the fixed service text", () => {
    expect(buildMentionReply(undefined)).toBe(
      "AI Reviewer is an automated check against a published rule catalog and does not answer questions.",
    );
    expect(buildMentionReply("https://rules.example.com/rules")).toBe(
      "AI Reviewer is an automated check against a published rule catalog and does not answer questions. Rule catalog: https://rules.example.com/rules",
    );
  });
});
