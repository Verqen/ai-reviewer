import { Config } from "~/shared/config";
import { z } from "zod";

const Context7ConfigSchema = z.object({
  CONTEXT7_API_KEY: z.string().optional(),
  CONTEXT7_BASE_URL: z.string().default("https://context7.com"),
  CONTEXT7_ENABLED: z
    .string()
    .transform((v) => v !== "false")
    .default(true),
  CONTEXT7_MAX_TOKENS: z.coerce.number().int().positive().default(2500),
});

type Context7ConfigSchema = z.infer<typeof Context7ConfigSchema>;

class Context7Config extends Config<Context7ConfigSchema> {
  constructor() {
    super(() => Context7ConfigSchema.parse(process.env));
  }
}

export { Context7Config };
export type { Context7ConfigSchema };
