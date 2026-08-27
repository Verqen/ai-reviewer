import type { IJobQueue } from "~/domain/ports/job-queue.port";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAYS_MS = [5000, 15000, 60000];

interface QueuedJob<T> {
  handler: (job: T) => Promise<void>;
  job: T;
  key: string;
  retriesLeft: number;
}

type ErrorHandler = (key: string, error: unknown, retriesLeft: number) => void;

class JobQueue<T> implements IJobQueue<T> {
  private readonly queuedKeys = new Set<string>();
  private readonly activeKeys = new Set<string>();
  private readonly retryingKeys = new Set<string>();
  private readonly pending: QueuedJob<T>[] = [];
  private draining = false;
  private drainResolvers: Array<() => void> = [];
  private errorHandler: ErrorHandler | null = null;

  constructor(
    private readonly concurrency: number = DEFAULT_CONCURRENCY,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
  ) {}

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  enqueue(key: string, job: T, handler: (job: T) => Promise<void>): boolean {
    if (this.draining) {
      return false;
    }

    if (this.isPending(key)) {
      return false;
    }

    this.queuedKeys.add(key);
    this.pending.push({ handler, job, key, retriesLeft: this.maxRetries });
    this.tick();
    return true;
  }

  isPending(key: string): boolean {
    return (
      this.queuedKeys.has(key) ||
      this.activeKeys.has(key) ||
      this.retryingKeys.has(key)
    );
  }

  async drain(): Promise<void> {
    this.draining = true;

    if (this.isIdle()) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  get size(): number {
    return this.queuedKeys.size + this.activeKeys.size + this.retryingKeys.size;
  }

  get activeCount(): number {
    return this.activeKeys.size;
  }

  private tick(): void {
    while (this.activeKeys.size < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();

      if (!next) {
        break;
      }

      this.queuedKeys.delete(next.key);
      this.activeKeys.add(next.key);
      void this.execute(next);
    }
  }

  private async execute(queued: QueuedJob<T>): Promise<void> {
    try {
      await queued.handler(queued.job);
      this.activeKeys.delete(queued.key);
    } catch (err: unknown) {
      const willRetry = queued.retriesLeft > 0 && !this.draining;
      if (willRetry) {
        this.retryingKeys.add(queued.key);
      }
      this.activeKeys.delete(queued.key);
      this.errorHandler?.(queued.key, err, queued.retriesLeft);

      if (willRetry) {
        const attempt = this.maxRetries - queued.retriesLeft;
        const delay =
          this.retryDelaysMs[attempt] ??
          this.retryDelaysMs[this.retryDelaysMs.length - 1] ??
          60000;

        queued.retriesLeft--;

        await new Promise<void>((resolve) => setTimeout(resolve, delay));

        this.retryingKeys.delete(queued.key);
        if (!this.draining) {
          this.queuedKeys.add(queued.key);
          this.pending.push(queued);
        }
      }
    }

    this.tick();
    this.checkDrained();
  }

  private isIdle(): boolean {
    return (
      this.activeKeys.size === 0 &&
      this.retryingKeys.size === 0 &&
      this.pending.length === 0
    );
  }

  private checkDrained(): void {
    if (this.isIdle()) {
      for (const resolve of this.drainResolvers) {
        resolve();
      }

      this.drainResolvers = [];
    }
  }
}

export { JobQueue };
