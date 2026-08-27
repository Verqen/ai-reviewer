import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type {
  DatabaseConnection,
  Driver,
  QueryResult,
  Kysely as KyselyType,
} from "kysely";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { Database } from "~/infrastructure/database/types";

import { readinessRoute } from "./readiness.route";

const PROBE_DEADLINE_MS = 2_000;
const VERDICT_TTL_MS = 5_000;

type ProbeBehaviour = "fail" | "hang_on_acquire" | "held_query" | "ok";

class ProbeDriver implements Driver {
  public acquireCount = 0;
  public queryCount = 0;
  public behaviour: ProbeBehaviour = "ok";

  private readonly heldQueries: Array<() => void> = [];

  private readonly connection: DatabaseConnection = {
    executeQuery: (): Promise<QueryResult<never>> => {
      this.queryCount++;

      if (this.behaviour === "fail") {
        return Promise.reject(new Error("connection refused"));
      }

      if (this.behaviour === "held_query") {
        return new Promise<QueryResult<never>>((resolve) => {
          this.heldQueries.push(() => {
            resolve({ rows: [] });
          });
        });
      }

      return Promise.resolve({ rows: [] });
    },
    streamQuery: (): AsyncIterableIterator<QueryResult<never>> => {
      throw new Error("streamQuery is not supported by the probe driver");
    },
  };

  releaseHeldQueries(): void {
    for (const release of this.heldQueries) {
      release();
    }

    this.heldQueries.length = 0;
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    this.acquireCount++;

    if (this.behaviour === "hang_on_acquire") {
      return new Promise<DatabaseConnection>(() => undefined);
    }

    return Promise.resolve(this.connection);
  }

  beginTransaction(): Promise<void> {
    return Promise.resolve();
  }

  commitTransaction(): Promise<void> {
    return Promise.resolve();
  }

  rollbackTransaction(): Promise<void> {
    return Promise.resolve();
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function createProbeDb(driver: Driver): KyselyType<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

interface WarnRecord {
  err: unknown;
  message: string;
}

function readErr(payload: unknown): unknown {
  if (typeof payload === "object" && payload !== null && "err" in payload) {
    return payload.err;
  }
  return undefined;
}

function createRecordingLogger(): {
  logger: FastifyBaseLogger;
  warns: WarnRecord[];
} {
  const warns: WarnRecord[] = [];
  const warn: FastifyBaseLogger["warn"] = (
    payload: unknown,
    message?: string,
  ): void => {
    warns.push({ err: readErr(payload), message: message ?? "" });
  };
  const noop = vi.fn();
  const logger: FastifyBaseLogger = {
    child: () => logger,
    debug: noop,
    error: noop,
    fatal: noop,
    info: noop,
    level: "info",
    silent: noop,
    trace: noop,
    warn,
  };

  return { logger, warns };
}

class StubQueue implements IJobQueue<ReviewJob> {
  public activeCount = 0;
  public size = 0;

  drain(): Promise<void> {
    return Promise.resolve();
  }

  enqueue(): boolean {
    return true;
  }

  isPending(): boolean {
    return false;
  }
}

function buildApp(): {
  app: FastifyInstance;
  driver: ProbeDriver;
  queue: StubQueue;
  warns: WarnRecord[];
} {
  const driver = new ProbeDriver();
  const queue = new StubQueue();
  const { logger, warns } = createRecordingLogger();
  const app = Fastify({ disableRequestLogging: true, loggerInstance: logger });

  app.register(readinessRoute, { db: createProbeDb(driver), queue });

  return { app, driver, queue, warns };
}

describe("readinessRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the database as ready when the probe succeeds", async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: "GET", url: "/readiness" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      checks: { database: "ok" },
      status: "ready",
    });
  });

  it("fails the probe when acquiring a connection outlives the deadline", async () => {
    const { app, driver, warns } = buildApp();
    driver.behaviour = "hang_on_acquire";

    const pending = app.inject({ method: "GET", url: "/readiness" });
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    const response = await pending;

    expect(driver.queryCount).toBe(0);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      checks: { database: "error" },
      status: "unready",
    });
    expect(warns.length).toBeGreaterThan(0);
  });

  it("collapses concurrent probes onto a single database round-trip", async () => {
    const { app, driver } = buildApp();
    driver.behaviour = "held_query";

    const responses = [
      app.inject({ method: "GET", url: "/readiness" }),
      app.inject({ method: "GET", url: "/readiness" }),
      app.inject({ method: "GET", url: "/readiness" }),
    ];

    await vi.advanceTimersByTimeAsync(1);
    expect(driver.queryCount).toBe(1);

    driver.releaseHeldQueries();
    const settled = await Promise.all(responses);

    expect(settled.map((response) => response.statusCode)).toEqual([
      200, 200, 200,
    ]);
    expect(driver.queryCount).toBe(1);
  });

  it("serves the cached verdict until the ttl expires", async () => {
    const { app, driver } = buildApp();

    await app.inject({ method: "GET", url: "/readiness" });
    await app.inject({ method: "GET", url: "/readiness" });
    expect(driver.queryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(VERDICT_TTL_MS);
    await app.inject({ method: "GET", url: "/readiness" });

    expect(driver.queryCount).toBe(2);
  });

  it("logs the probe error and answers unready when the query rejects", async () => {
    const { app, driver, warns } = buildApp();
    driver.behaviour = "fail";

    const response = await app.inject({ method: "GET", url: "/readiness" });

    expect(response.statusCode).toBe(503);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.err).toBeInstanceOf(Error);
    expect(warns[0]?.message).toContain("Readiness database probe failed");
  });

  it("reads queue depth live while the database verdict is cached", async () => {
    const { app, driver, queue } = buildApp();

    await app.inject({ method: "GET", url: "/readiness" });
    queue.size = 7;
    queue.activeCount = 3;
    const response = await app.inject({ method: "GET", url: "/readiness" });

    expect(driver.queryCount).toBe(1);
    expect(response.json()).toMatchObject({ activeJobs: 3, queueDepth: 7 });
  });
});
