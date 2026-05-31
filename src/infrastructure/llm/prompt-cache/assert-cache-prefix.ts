import type { FastifyBaseLogger } from "fastify";

import { estimateTokens, getCacheMinTokens } from "./cache-thresholds";

function shouldApplyCachePrefix(
  prefix: string,
  model: string,
  logger: FastifyBaseLogger
): boolean {
  const minTokens = getCacheMinTokens(model);
  if (minTokens === null) return false;
  const estimated = estimateTokens(prefix);
  if (estimated < minTokens) {
    logger.debug(
      { chars: prefix.length, estimated, minTokens, model },
      "prompt cache prefix below min tokens; skipping cache_control"
    );
    return false;
  }
  logger.debug(
    { chars: prefix.length, estimated, minTokens, model },
    "prompt cache prefix size check passed"
  );
  return true;
}

export { shouldApplyCachePrefix };
