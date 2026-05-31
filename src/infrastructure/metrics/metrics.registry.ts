import { collectDefaultMetrics, Registry } from "prom-client";

function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

export { createMetricsRegistry };
