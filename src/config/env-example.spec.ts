import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppConfig } from "~/config/app.config";
import { Context7Config } from "~/config/context7.config";
import { DatabaseConfig } from "~/config/database.config";
import { GitHubConfig } from "~/config/github.config";
import { GitLabConfig } from "~/config/gitlab.config";
import { LlmConfig } from "~/config/llm.config";
import { OpenRouterConfig } from "~/config/openrouter.config";
import { PipelineConfig } from "~/config/pipeline.config";
import { getReviewLanguage } from "~/config/review-language";
import { readRuntimeEnv } from "~/config/runtime.env";
import { WebhookConfig } from "~/config/webhook.config";

function readEnvExample(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".env.example"), "utf-8");
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries[match[1]] = match[2];
    }
  }
  return entries;
}

const REQUIRED_FOR_BOOT = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  GITHUB_TOKEN: "github-token",
  GITLAB_API_URL: "https://gitlab.example.com/api/v4",
  GITLAB_TOKEN: "token",
  OPENROUTER_API_KEY: "key",
  WEBHOOK_SECRET: "secret",
} as const;

function buildAllConfigs(): Record<string, unknown> {
  return {
    app: new AppConfig().envs,
    context7: new Context7Config().envs,
    database: new DatabaseConfig().envs,
    github: new GitHubConfig().envs,
    gitlab: new GitLabConfig().envs,
    llm: new LlmConfig().envs,
    openrouter: new OpenRouterConfig().envs,
    pipeline: new PipelineConfig().envs,
    runtime: { ...readRuntimeEnv(), REVIEW_LANGUAGE: getReviewLanguage() },
    webhook: new WebhookConfig().envs,
  };
}

function applyEnv(values: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, values);
}

describe(".env.example", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyEnv({});
  });

  afterEach(() => {
    applyEnv({});
    Object.assign(process.env, originalEnv);
  });

  it("is a complete, valid configuration on its own", () => {
    applyEnv({ ...readEnvExample(), ...REQUIRED_FOR_BOOT });
    expect(() => buildAllConfigs()).not.toThrow();
  });

  it("documents the same values the schemas fall back to", () => {
    applyEnv(REQUIRED_FOR_BOOT);
    const defaults = buildAllConfigs();

    applyEnv({ ...readEnvExample(), ...REQUIRED_FOR_BOOT });
    const documented = buildAllConfigs();

    expect(documented).toEqual(defaults);
  });
});
