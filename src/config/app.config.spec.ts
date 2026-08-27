import { describe, expect, it } from "vitest";

import { AppConfigSchema } from "~/config/app.config";

const PINO_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

describe("AppConfigSchema", () => {
  it.each(PINO_LEVELS)("accepts the pino level %s", (level) => {
    expect(AppConfigSchema.parse({ LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
  });

  it("falls back to info", () => {
    expect(AppConfigSchema.parse({}).LOG_LEVEL).toBe("info");
  });

  it.each(["verbose", "INFO", "warning", "", "10"])(
    "rejects %o at config time instead of at logger construction",
    (level) => {
      expect(AppConfigSchema.safeParse({ LOG_LEVEL: level }).success).toBe(
        false,
      );
    },
  );
});
