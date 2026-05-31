import { Registry } from "prom-client";

import { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";

function createMockPipelineMetrics(): PipelineMetrics {
  return new PipelineMetrics(new Registry());
}

export { createMockPipelineMetrics };
