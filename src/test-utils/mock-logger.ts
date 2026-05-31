import type { FastifyBaseLogger } from "fastify";

function createMockLogger(): FastifyBaseLogger {
  const noop = (): void => undefined;

  const logger = {
    child: (): FastifyBaseLogger => logger,
    debug: noop,
    error: noop,
    fatal: noop,
    info: noop,
    level: "silent",
    silent: noop,
    trace: noop,
    warn: noop,
  } as unknown as FastifyBaseLogger;

  return logger;
}

export { createMockLogger };
