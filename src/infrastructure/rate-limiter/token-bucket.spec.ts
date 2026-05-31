import { describe, expect, it, vi } from "vitest";

import { TokenBucket } from "~/infrastructure/rate-limiter/token-bucket";

describe("TokenBucket", () => {
  it("allows acquiring tokens when bucket is full", () => {
    const bucket = new TokenBucket(10, 1);
    expect(bucket.tryAcquire(5)).toBe(true);
  });

  it("rejects when not enough tokens", () => {
    const bucket = new TokenBucket(5, 1);
    expect(bucket.tryAcquire(10)).toBe(false);
  });

  it("consumes tokens on tryAcquire", () => {
    const bucket = new TokenBucket(10, 0);
    expect(bucket.tryAcquire(8)).toBe(true);
    expect(bucket.tryAcquire(3)).toBe(false);
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(10, 10);
    bucket.tryAcquire(10);
    vi.advanceTimersByTime(500);
    expect(bucket.tryAcquire(5)).toBe(true);
    vi.useRealTimers();
  });

  it("does not exceed capacity on refill", () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(5, 100);
    vi.advanceTimersByTime(1000);
    expect(bucket.tryAcquire(5)).toBe(true);
    expect(bucket.tryAcquire(1)).toBe(false);
    vi.useRealTimers();
  });

  it("acquire waits until tokens are available", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(1, 10);
    bucket.tryAcquire(1);

    const acquirePromise = bucket.acquire(1);
    vi.advanceTimersByTime(200);
    await acquirePromise;
    vi.useRealTimers();
  });

  it("tryAcquire defaults to 1 token", () => {
    const bucket = new TokenBucket(1, 0);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
  });
});
