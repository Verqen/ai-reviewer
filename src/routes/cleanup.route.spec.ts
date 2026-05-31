import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

import { cleanupRoute } from "./cleanup.route";

function buildMockApp(options: {
  retentionDays: number;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
}) {
  const app = Fastify({ logger: false });

  app.register(cleanupRoute, {
    appConfig: {
      envs: {
        CLEANUP_RETENTION_DAYS: options.retentionDays,
        HOST: "0.0.0.0",
        LOG_LEVEL: "info",
        PORT: 3000,
        SHUTDOWN_TIMEOUT_MS: 240_000,
      },
    },
    reviewRunRepo: options.reviewRunRepo,
    snapshotRepo: options.snapshotRepo,
  });

  return app;
}

describe("cleanupRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 200 with deletion counts and cutoff from retention days", async () => {
    const deleteCompletedOrFailedBefore = vi.fn().mockResolvedValue(3);
    const deleteOldSnapshotsBefore = vi.fn().mockResolvedValue(5);
    const reviewRunRepo = {
      deleteCompletedOrFailedBefore,
    } as unknown as IReviewRunRepository;
    const snapshotRepo = {
      deleteOldSnapshotsBefore,
    } as unknown as ISnapshotRepository;
    const app = buildMockApp({
      retentionDays: 10,
      reviewRunRepo,
      snapshotRepo,
    });
    const response = await app.inject({ method: "POST", url: "/cleanup" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      cutoff: string;
      deletedReviewRuns: number;
      deletedSnapshots: number;
    };
    expect(body.deletedReviewRuns).toBe(3);
    expect(body.deletedSnapshots).toBe(5);
    expect(body.cutoff).toBe("2024-06-05T12:00:00.000Z");
    expect(deleteCompletedOrFailedBefore).toHaveBeenCalledTimes(1);
    expect(deleteOldSnapshotsBefore).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(deleteCompletedOrFailedBefore).mock
      .calls[0]?.[0] as Date;
    expect(firstArg).toBeInstanceOf(Date);
    expect(firstArg.getTime()).toBe(
      new Date("2024-06-05T12:00:00.000Z").getTime()
    );
    expect(vi.mocked(deleteOldSnapshotsBefore).mock.calls[0]?.[0]).toEqual(
      firstArg
    );
  });
});
