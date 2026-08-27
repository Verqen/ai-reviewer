import { Config } from "~/shared/config";
import { z } from "zod";

import { booleanEnv } from "~/config/boolean-env";
import {
  DEFAULT_WEBHOOK_MAX_QUEUE_SIZE,
  MIN_WEBHOOK_MAX_QUEUE_SIZE,
} from "~/config/constants";
import { optionalEnv } from "~/config/optional-env";

const WebhookConfigSchema = z
  .object({
    WEBHOOK_MAX_QUEUE_SIZE: z.coerce
      .number()
      .int()
      .min(MIN_WEBHOOK_MAX_QUEUE_SIZE)
      .default(DEFAULT_WEBHOOK_MAX_QUEUE_SIZE),
    WEBHOOK_SECRET: optionalEnv(z.string()),
    WEBHOOK_SIGNATURE_REQUIRED: booleanEnv(true),
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
  constructor(envs?: WebhookConfigSchema) {
    super(() => envs ?? WebhookConfigSchema.parse(process.env));
  }
}

export { WebhookConfig, WebhookConfigSchema };
