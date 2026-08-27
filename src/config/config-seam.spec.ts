import { describe, expect, it } from "vitest";

import { AppConfig, AppConfigSchema } from "~/config/app.config";
import { DatabaseConfig, DatabaseConfigSchema } from "~/config/database.config";
import { GitHubConfig, GitHubConfigSchema } from "~/config/github.config";
import { GitLabConfig, GitLabConfigSchema } from "~/config/gitlab.config";
import { LlmConfig, LlmConfigSchema } from "~/config/llm.config";
import {
  OpenRouterConfig,
  OpenRouterConfigSchema,
} from "~/config/openrouter.config";
import { PipelineConfig, PipelineConfigSchema } from "~/config/pipeline.config";
import { getReviewLanguage } from "~/config/review-language";
import { readRuntimeEnv } from "~/config/runtime.env";
import { WebhookConfig, WebhookConfigSchema } from "~/config/webhook.config";

const SENTINEL_URL = "https://seam.invalid/never-in-the-environment";

describe("config seam", () => {
  it("uses the injected values for a config whose variables are required", () => {
    const envs = DatabaseConfigSchema.parse({ DATABASE_URL: SENTINEL_URL });

    expect(process.env["DATABASE_URL"]).not.toBe(SENTINEL_URL);
    expect(new DatabaseConfig(envs).envs).toEqual(envs);
  });

  it("keeps the injected value for a variable the environment also defines", () => {
    const envs = AppConfigSchema.parse({ LOG_LEVEL: "silent", PORT: "4242" });

    const config = new AppConfig(envs);

    expect(config.envs.LOG_LEVEL).toBe("silent");
    expect(config.envs.PORT).toBe(4242);
  });

  it("builds every config from an explicit parsed schema", () => {
    const configs = {
      app: new AppConfig(AppConfigSchema.parse({})).envs,
      github: new GitHubConfig(
        GitHubConfigSchema.parse({ GITHUB_TOKEN: "seam-token" }),
      ).envs,
      gitlab: new GitLabConfig(
        GitLabConfigSchema.parse({
          GITLAB_API_URL: SENTINEL_URL,
          GITLAB_TOKEN: "seam-token",
        }),
      ).envs,
      llm: new LlmConfig(LlmConfigSchema.parse({ LLM_PROVIDER: "ollama" }))
        .envs,
      openrouter: new OpenRouterConfig(
        OpenRouterConfigSchema.parse({ OPENROUTER_API_KEY: "seam-key" }),
      ).envs,
      pipeline: new PipelineConfig(
        PipelineConfigSchema.parse({ REVIEW_BASELINE_POLL_MS: "17" }),
      ).envs,
      webhook: new WebhookConfig(
        WebhookConfigSchema.parse({ WEBHOOK_SECRET: "seam-secret" }),
      ).envs,
    };

    expect(configs.github.GITHUB_TOKEN).toBe("seam-token");
    expect(configs.gitlab.GITLAB_API_URL).toBe(SENTINEL_URL);
    expect(configs.llm.LLM_PROVIDER).toBe("ollama");
    expect(configs.openrouter.OPENROUTER_API_KEY).toBe("seam-key");
    expect(configs.pipeline.REVIEW_BASELINE_POLL_MS).toBe(17);
    expect(configs.webhook.WEBHOOK_SECRET).toBe("seam-secret");
    expect(configs.app.HOST).toBe("127.0.0.1");
  });

  it("freezes the injected values", () => {
    const config = new DatabaseConfig(
      DatabaseConfigSchema.parse({ DATABASE_URL: SENTINEL_URL }),
    );

    expect(Object.isFrozen(config.envs)).toBe(true);
  });

  it("reads the runtime env from an explicit source", () => {
    const runtime = readRuntimeEnv({
      CODE_HOST_PROVIDER: "github",
      SHOW_REVIEW_COST_FOOTER: "true",
    });

    expect(runtime.CODE_HOST_PROVIDER).toBe("github");
    expect(runtime.SHOW_REVIEW_COST_FOOTER).toBe(true);
  });

  it("resolves the review language from an explicit source", () => {
    expect(getReviewLanguage({ REVIEW_LANGUAGE: "ru" })).toBe("Russian");
    expect(getReviewLanguage({})).toBe("English");
  });
});
