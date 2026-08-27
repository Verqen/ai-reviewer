import { Config } from "~/shared/config";
import { z } from "zod";

import { optionalEnv } from "~/config/optional-env";

const AppConfigSchema = z.object({
  CLEANUP_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  CLEANUP_TOKEN: optionalEnv(z.string().min(32)),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().default(3000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240_000),
});

type AppConfigSchema = z.infer<typeof AppConfigSchema>;

class AppConfig extends Config<AppConfigSchema> {
  constructor() {
    super(() => AppConfigSchema.parse(process.env));
  }
}

export { AppConfig };
export type { AppConfigSchema };
