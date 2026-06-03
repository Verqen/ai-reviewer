import { describe, expect, it } from "vitest";

import { isRetryableStatus, retryAfterMs } from "./github-resilience";

describe("isRetryableStatus", () => {
  it("retries on rate-limit and server errors", () => {
    for (const status of [403, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("does not retry on client errors that are not rate limits", () => {
    for (const status of [400, 401, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("retryAfterMs", () => {
  it("honors a retry-after header in seconds, capped", () => {
    const error = { response: { headers: { "retry-after": "5" } } };
    expect(retryAfterMs(error, 0)).toBe(5000);
    const huge = { response: { headers: { "retry-after": "9999" } } };
    expect(retryAfterMs(huge, 0)).toBe(20000);
  });

  it("honors x-ratelimit-reset as an absolute epoch", () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 4;
    const error = {
      response: { headers: { "x-ratelimit-reset": String(resetEpoch) } },
    };
    const ms = retryAfterMs(error, 0);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20000);
  });

  it("falls back to exponential backoff with jitter within bounds", () => {
    const error = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      const ms = retryAfterMs(error, attempt);
      expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** attempt);
      expect(ms).toBeLessThanOrEqual(20000);
    }
  });
});
