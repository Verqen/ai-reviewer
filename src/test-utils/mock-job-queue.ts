import type { IJobQueue } from "~/domain/ports/job-queue.port";

function createMockJobQueue<T>(
  overrides: Partial<IJobQueue<T>> = {},
): IJobQueue<T> {
  return {
    activeCount: 0,
    drain: () => Promise.resolve(),
    enqueue: () => true,
    isPending: () => false,
    size: 0,
    ...overrides,
  };
}

export { createMockJobQueue };
