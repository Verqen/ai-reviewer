import type { ICache } from "~/domain/ports/cache.port";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

class MemoryCache<T> implements ICache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxSize: number = DEFAULT_MAX_SIZE,
    private readonly defaultTtlMs: number = DEFAULT_TTL_MS,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this.evict();
    }

    this.store.set(key, {
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
      value,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      this.store.delete(key);
    }

    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;

      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
  }
}

export { MemoryCache };
