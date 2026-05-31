import { describe, expect, it } from "vitest";

import { isBotMentioned, isReviewRequest } from "./note-text-guards";

describe("note-text-guards", () => {
  describe("isBotMentioned", () => {
    it("returns true when note contains @username case-insensitively", () => {
      expect(isBotMentioned("Please @AI check this", "ai")).toBe(true);
    });

    it("returns false when bot is not mentioned", () => {
      expect(isBotMentioned("Hello world", "ai")).toBe(false);
    });
  });

  describe("isReviewRequest", () => {
    it("returns true when note contains review word", () => {
      expect(isReviewRequest("@ai please review")).toBe(true);
    });

    it("returns false for explain without review", () => {
      expect(isReviewRequest("@ai explain this")).toBe(false);
    });
  });
});
