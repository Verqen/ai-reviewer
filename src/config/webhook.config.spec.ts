import { describe, expect, it } from "vitest";

import { WebhookConfig, WebhookConfigSchema } from "~/config/webhook.config";

describe("WebhookConfigSchema", () => {
  it("accepts a configured secret", () => {
    const envs = WebhookConfigSchema.parse({ WEBHOOK_SECRET: "shared-secret" });

    expect(new WebhookConfig(envs).envs.WEBHOOK_SECRET).toBe("shared-secret");
  });

  it("refuses to start when the secret is missing", () => {
    expect(WebhookConfigSchema.safeParse({}).success).toBe(false);
  });

  it("refuses to start when the secret is blank", () => {
    expect(
      WebhookConfigSchema.safeParse({ WEBHOOK_SECRET: "   " }).success,
    ).toBe(false);
  });

  it("allows an unsigned webhook only when signature checking is disabled", () => {
    const envs = WebhookConfigSchema.parse({
      WEBHOOK_SIGNATURE_REQUIRED: "false",
    });

    expect(envs.WEBHOOK_SECRET).toBeUndefined();
    expect(envs.WEBHOOK_SIGNATURE_REQUIRED).toBe(false);
  });

  it.each(["0", "no", "off", "disabled"])(
    "refuses %o for the signature flag",
    (value) => {
      expect(
        WebhookConfigSchema.safeParse({ WEBHOOK_SIGNATURE_REQUIRED: value })
          .success,
      ).toBe(false);
    },
  );
});
