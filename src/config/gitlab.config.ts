import { Config } from "~/shared/config";
import { z } from "zod";

const GitLabConfigSchema = z.object({
  GITLAB_API_URL: z.url(),
  GITLAB_BOT_USERNAME: z.string().default("ai"),
  GITLAB_TOKEN: z.string(),
});

type GitLabConfigSchema = z.infer<typeof GitLabConfigSchema>;

class GitLabConfig extends Config<GitLabConfigSchema> {
  constructor() {
    super(() => GitLabConfigSchema.parse(process.env));
  }
}

export { GitLabConfig };
export type { GitLabConfigSchema };
