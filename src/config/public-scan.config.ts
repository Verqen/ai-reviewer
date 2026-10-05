import { Config } from "~/shared/config";
import { z } from "zod";

import { optionalEnv } from "~/config/optional-env";

const PublicScanConfigSchema = z.object({
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GITHUB_TOKEN: optionalEnv(z.string()),
  PUBLIC_SCAN_MAX_COST_USD: optionalEnv(z.coerce.number().positive()).pipe(
    z.number().positive().default(0.5),
  ),
});

type PublicScanConfigSchema = z.infer<typeof PublicScanConfigSchema>;

class PublicScanConfig extends Config<PublicScanConfigSchema> {
  constructor(envs?: PublicScanConfigSchema) {
    super(() => envs ?? PublicScanConfigSchema.parse(process.env));
  }
}

export { PublicScanConfig, PublicScanConfigSchema };
