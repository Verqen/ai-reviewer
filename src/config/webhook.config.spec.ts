import { afterEach, describe, expect, it } from "vitest";

import { WebhookConfig } from "~/config/webhook.config";

const TOUCHED_KEYS = [
  "WEBHOOK_SECRET",
  "WEBHOOK_SIGNATURE_REQUIRED",
  "WEBHOOK_MAX_QUEUE_SIZE",
] as const;

function setEnv(
  values: Partial<Record<(typeof TOUCHED_KEYS)[number], string>>,
) {
  for (const key of TOUCHED_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

describe("WebhookConfig", () => {
  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
  });

  it("accepts a configured secret", () => {
    setEnv({ WEBHOOK_SECRET: "shared-secret" });
    expect(new WebhookConfig().envs.WEBHOOK_SECRET).toBe("shared-secret");
  });

  it("refuses to start when the secret is missing", () => {
    setEnv({});
    expect(() => new WebhookConfig()).toThrow();
  });

  it("refuses to start when the secret is blank", () => {
    setEnv({ WEBHOOK_SECRET: "   " });
    expect(() => new WebhookConfig()).toThrow();
  });

  it("allows an unsigned webhook only when signature checking is disabled", () => {
    setEnv({ WEBHOOK_SIGNATURE_REQUIRED: "false" });
    const config = new WebhookConfig();
    expect(config.envs.WEBHOOK_SECRET).toBeUndefined();
    expect(config.envs.WEBHOOK_SIGNATURE_REQUIRED).toBe(false);
  });
});
