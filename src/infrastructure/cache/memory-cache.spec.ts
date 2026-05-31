import { describe, expect, it, vi } from "vitest";

import { MemoryCache } from "~/infrastructure/cache/memory-cache";

describe("MemoryCache", () => {
  it("stores and retrieves values", () => {
    const cache = new MemoryCache<string>();
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new MemoryCache<string>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns undefined for expired entries", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>(100, 1000);
    cache.set("key1", "value1", 500);
    vi.advanceTimersByTime(600);
    expect(cache.get("key1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns value before TTL expires", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>(100, 1000);
    cache.set("key1", "value1", 1000);
    vi.advanceTimersByTime(500);
    expect(cache.get("key1")).toBe("value1");
    vi.useRealTimers();
  });

  it("has() returns true for live entries", () => {
    const cache = new MemoryCache<string>();
    cache.set("key1", "value1");
    expect(cache.has("key1")).toBe(true);
  });

  it("has() returns false for expired entries", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>(100, 1000);
    cache.set("key1", "value1", 100);
    vi.advanceTimersByTime(200);
    expect(cache.has("key1")).toBe(false);
    vi.useRealTimers();
  });

  it("delete() removes an entry", () => {
    const cache = new MemoryCache<string>();
    cache.set("key1", "value1");
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
  });

  it("clear() removes all entries", () => {
    const cache = new MemoryCache<string>();
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("evicts oldest when maxSize is reached", () => {
    const cache = new MemoryCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.get("d")).toBe(4);
  });

  it("size reflects current entry count", () => {
    const cache = new MemoryCache<string>();
    expect(cache.size).toBe(0);
    cache.set("key1", "value1");
    expect(cache.size).toBe(1);
    cache.set("key2", "value2");
    expect(cache.size).toBe(2);
    cache.delete("key1");
    expect(cache.size).toBe(1);
  });

  it("updates existing key without growing size", () => {
    const cache = new MemoryCache<string>();
    cache.set("key1", "value1");
    cache.set("key1", "value2");
    expect(cache.get("key1")).toBe("value2");
    expect(cache.size).toBe(1);
  });
});
