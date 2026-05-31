/**
 * In-memory TTL cache contract for review deduplication and similar use cases.
 */
interface ICache<T> {
  clear(): void;
  delete(key: string): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: T, ttlMs?: number): void;
  readonly size: number;
}

export type { ICache };
