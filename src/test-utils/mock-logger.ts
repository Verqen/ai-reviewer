import type { FastifyBaseLogger } from "fastify";

function createMockLogger(
  overrides: Partial<FastifyBaseLogger> = {},
): FastifyBaseLogger {
  const noop = (): void => undefined;

  const logger: FastifyBaseLogger = {
    child: (): FastifyBaseLogger => logger,
    debug: noop,
    error: noop,
    fatal: noop,
    info: noop,
    level: "silent",
    silent: noop,
    trace: noop,
    warn: noop,
    ...overrides,
  };

  return logger;
}

export { createMockLogger };
