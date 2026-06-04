import type { FastifyBaseLogger } from "fastify";

function createSilentLogger(): FastifyBaseLogger {
  const noop = (): void => undefined;
  const logger: FastifyBaseLogger = {
    debug: noop,
    error: noop,
    fatal: noop,
    info: noop,
    level: "silent",
    msgPrefix: "",
    silent: noop,
    trace: noop,
    warn: noop,
    child: () => logger,
  };
  return logger;
}

export { createSilentLogger };
