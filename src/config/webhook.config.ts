import { Config } from "~/shared/config";
import { z } from "zod";

const WebhookConfigSchema = z
  .object({
    WEBHOOK_MAX_QUEUE_SIZE: z.coerce.number().int().min(1).default(150),
    WEBHOOK_SECRET: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || value.trim() === "" ? undefined : value,
      ),
    WEBHOOK_SIGNATURE_REQUIRED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .refine(
    (envs) =>
      !envs.WEBHOOK_SIGNATURE_REQUIRED || envs.WEBHOOK_SECRET !== undefined,
    {
      message:
        "WEBHOOK_SECRET must be set. To accept unsigned webhooks on a trusted network, set WEBHOOK_SIGNATURE_REQUIRED=false.",
      path: ["WEBHOOK_SECRET"],
    },
  );

type WebhookConfigSchema = z.infer<typeof WebhookConfigSchema>;

class WebhookConfig extends Config<WebhookConfigSchema> {
  constructor() {
    super(() => WebhookConfigSchema.parse(process.env));
  }
}

export { WebhookConfig };
export type { WebhookConfigSchema };
