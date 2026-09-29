import { describe, expect, it } from "vitest";

import { findCatalogRule } from "~/domain/rule-catalog/rule-catalog";
import {
  buildMentionReply,
  buildRuleThreadReply,
} from "~/domain/rule-catalog/thread-reply";

describe("thread replies", () => {
  it("answers a question on a finding with the fixed rule text", () => {
    const rule = findCatalogRule("R-013");
    if (rule === undefined) throw new Error("missing");
    expect(buildRuleThreadReply(rule, "https://verqen.dev/rules")).toBe(
      "Verqen is an automated check against a published rule catalog and does not answer questions about findings. Rule R-013: A function or value is referenced in a file where it is neither declared nor imported. https://verqen.dev/rules#R-013",
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
