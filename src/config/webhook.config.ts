import { Config } from "~/shared/config";
import { z } from "zod";

const WebhookConfigSchema = z.object({
  WEBHOOK_MAX_QUEUE_SIZE: z.coerce.number().int().min(1).default(150),
  WEBHOOK_SECRET: z.string().optional(),
});

type WebhookConfigSchema = z.infer<typeof WebhookConfigSchema>;

class WebhookConfig extends Config<WebhookConfigSchema> {
  constructor() {
    super(() => WebhookConfigSchema.parse(process.env));
  }
}

export { WebhookConfig };
export type { WebhookConfigSchema };
