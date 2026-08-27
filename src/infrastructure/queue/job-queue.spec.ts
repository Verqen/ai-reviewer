import { describe, expect, it, vi } from "vitest";

import { JobQueue } from "~/infrastructure/queue/job-queue";

describe("JobQueue", () => {
  it("executes enqueued jobs", async () => {
    const queue = new JobQueue<null>(1);
    const executed: string[] = [];

    queue.enqueue("job1", null, () => {
      executed.push("job1");
      return Promise.resolve();
    });

    await queue.drain();
    expect(executed).toContain("job1");
  });

  it("respects concurrency limit", async () => {
    const queue = new JobQueue<null>(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeJob = () =>
      new Promise<void>((resolve) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        setTimeout(() => {
          concurrent--;
          resolve();
        }, 10);
      });

    queue.enqueue("job1", null, makeJob);
    queue.enqueue("job2", null, makeJob);
    queue.enqueue("job3", null, makeJob);

    await queue.drain();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("deduplicates by key", () => {
    const queue = new JobQueue<null>(1);

    const job1Enqueued = queue.enqueue(
      "same-key",
      null,
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );

    const job2Enqueued = queue.enqueue("same-key", null, () =>
      Promise.resolve(),
    );

    expect(job1Enqueued).toBe(true);
    expect(job2Enqueued).toBe(false);
  });

  it("isPending returns true for queued jobs", () => {
    const queue = new JobQueue<null>(1);

    queue.enqueue(
      "job1",
      null,
      () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );

    queue.enqueue("job2", null, () => Promise.resolve());

    expect(queue.isPending("job1")).toBe(true);
    expect(queue.isPending("job2")).toBe(true);
    expect(queue.isPending("unknown")).toBe(false);
  });

  it("drain resolves when queue is empty", async () => {
    const queue = new JobQueue<null>(2);
    const results: number[] = [];

    queue.enqueue("j1", null, () => {
      results.push(1);
      return Promise.resolve();
    });
    queue.enqueue("j2", null, () => {
      results.push(2);
      return Promise.resolve();
    });

    await queue.drain();
    expect(results).toHaveLength(2);
  });

  it("drain resolves immediately when empty", async () => {
    const queue = new JobQueue<null>();
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it("enqueue returns false after drain called", async () => {
    const queue = new JobQueue<null>();
    await queue.drain();
    const result = queue.enqueue("key", null, () => Promise.resolve());
    expect(result).toBe(false);
  });

  it("retries on handler failure", async () => {
    vi.useFakeTimers();
    const queue = new JobQueue<null>(1, 1, [10]);
    let attempts = 0;

    queue.enqueue("retry-job", null, () => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(new Error("Transient error"));
      }
      return Promise.resolve();
    });

    await vi.runAllTimersAsync();
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it("keeps a job awaiting retry visible to isPending and size", async () => {
    vi.useFakeTimers();
    const queue = new JobQueue<null>(1, 1, [10_000]);
    let attempts = 0;

    queue.enqueue("retry-job", null, () => {
      attempts++;
      return attempts < 2
        ? Promise.reject(new Error("Transient error"))
        : Promise.resolve();
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(1);
    expect(queue.isPending("retry-job")).toBe(true);
    expect(queue.size).toBe(1);

    await vi.runAllTimersAsync();
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it("does not resolve drain while a job is waiting to be retried", async () => {
    vi.useFakeTimers();
    const queue = new JobQueue<null>(2, 1, [10_000]);
    let attempts = 0;
    let drained = false;

    queue.enqueue("retry-job", null, () => {
      attempts++;
      return attempts < 2
        ? Promise.reject(new Error("Transient error"))
        : Promise.resolve();
    });
    queue.enqueue("fast-job", null, () => Promise.resolve());

    await vi.advanceTimersByTimeAsync(1);
    void queue.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);

    await vi.runAllTimersAsync();
    expect(drained).toBe(true);
    vi.useRealTimers();
  });

  it("size reflects queued + active count", () => {
    const queue = new JobQueue<null>(1);

    queue.enqueue(
      "job1",
      null,
      () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );
    queue.enqueue("job2", null, () => Promise.resolve());

    expect(queue.size).toBe(2);
  });
});
