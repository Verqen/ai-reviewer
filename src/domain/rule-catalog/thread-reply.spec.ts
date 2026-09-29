import { describe, expect, it } from "vitest";

import {
  buildFindingThreadReply,
  buildMentionReply,
} from "~/domain/rule-catalog/thread-reply";

describe("thread replies", () => {
  it("answers a question on a finding with the fixed rule text", () => {
    expect(buildFindingThreadReply("R-013", "https://verqen.dev/rules")).toBe(
      "Verqen is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013: A function or value is referenced in a file where it is neither declared nor imported. https://verqen.dev/rules#R-013",
    );
  });

  it("omits the link when no catalog url is configured", () => {
    expect(buildFindingThreadReply("R-013", undefined)).toBe(
      "Verqen is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013: A function or value is referenced in a file where it is neither declared nor imported.",
    );
  });

  it("returns an empty reply for a finding without a catalog rule", () => {
    expect(buildFindingThreadReply(undefined, "https://verqen.dev/rules")).toBe(
      "",
    );
    expect(buildFindingThreadReply(null, "https://verqen.dev/rules")).toBe("");
    expect(buildFindingThreadReply("R-999", "https://verqen.dev/rules")).toBe(
      "",
    );
  });

  it("answers a mention with the fixed service text", () => {
    expect(buildMentionReply(undefined)).toBe(
      "Verqen is an automated check against a published rule catalog and does not answer questions.",
    );
    expect(buildMentionReply("https://verqen.dev/rules")).toBe(
      "Verqen is an automated check against a published rule catalog and does not answer questions. Rule catalog: https://verqen.dev/rules",
    );
  });
});
