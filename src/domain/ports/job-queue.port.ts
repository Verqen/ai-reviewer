/**
 * Contract for keyed job scheduling with concurrency limits, used for review work orchestration.
 */
interface IJobQueue<T> {
  readonly activeCount: number;
  drain(): Promise<void>;
  enqueue(key: string, job: T, handler: (job: T) => Promise<void>): boolean;
  isPending(key: string): boolean;
  readonly size: number;
}

export type { IJobQueue };
