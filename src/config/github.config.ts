import { Config } from "~/shared/config";
import { z } from "zod";

import { optionalEnv } from "~/config/optional-env";

const GitHubConfigSchema = z
  .object({
    GITHUB_API_URL: z.url().default("https://api.github.com"),
    GITHUB_APP_ID: optionalEnv(z.string()),
    GITHUB_APP_INSTALLATION_ID: optionalEnv(z.coerce.number().int()),
    GITHUB_APP_PRIVATE_KEY: optionalEnv(z.string()),
    GITHUB_APP_PRIVATE_KEY_PATH: optionalEnv(z.string()),
    GITHUB_BOT_USERNAME: z.string().default("ai"),
    GITHUB_TOKEN: optionalEnv(z.string()),
  })
  .refine(
    (c) =>
      Boolean(c.GITHUB_TOKEN) ||
      (Boolean(c.GITHUB_APP_ID) &&
        (Boolean(c.GITHUB_APP_PRIVATE_KEY) ||
          Boolean(c.GITHUB_APP_PRIVATE_KEY_PATH)) &&
        c.GITHUB_APP_INSTALLATION_ID !== undefined),
    {
      message:
        "Provide GITHUB_TOKEN, or GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH).",
    },
  );

type GitHubConfigSchema = z.infer<typeof GitHubConfigSchema>;

class GitHubConfig extends Config<GitHubConfigSchema> {
  constructor() {
    super(() => GitHubConfigSchema.parse(process.env));
  }
}

export { GitHubConfig };
export type { GitHubConfigSchema };
