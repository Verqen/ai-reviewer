import { Config } from "~/shared/config";
import { z } from "zod";

import {
  DEFAULT_CLEANUP_RETENTION_DAYS,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MIN_CLEANUP_RETENTION_DAYS,
  MIN_CLEANUP_TOKEN_LENGTH,
  MIN_SHUTDOWN_TIMEOUT_MS,
} from "~/config/constants";
import { optionalEnv } from "~/config/optional-env";

const LogLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const AppConfigSchema = z.object({
  CLEANUP_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(MIN_CLEANUP_RETENTION_DAYS)
    .default(DEFAULT_CLEANUP_RETENTION_DAYS),
  CLEANUP_TOKEN: optionalEnv(z.string().min(MIN_CLEANUP_TOKEN_LENGTH)),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: LogLevelSchema.default("info"),
  PORT: z.coerce.number().default(DEFAULT_PORT),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_SHUTDOWN_TIMEOUT_MS)
    .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

type AppConfigSchema = z.infer<typeof AppConfigSchema>;

class AppConfig extends Config<AppConfigSchema> {
  constructor(envs?: AppConfigSchema) {
    super(() => envs ?? AppConfigSchema.parse(process.env));
  }
}

export { AppConfig, AppConfigSchema };
