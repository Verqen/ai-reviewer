import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import {
  ReviewPipelineConfigSchema,
  type LoadedReviewPipelineConfig,
} from "~/domain/types/config.types";

function resolveRulesFallbackPath(): string {
  return (
    process.env["RULES_FALLBACK_PATH"] ??
    resolve(process.cwd(), ".agents/REVIEW.md")
  );
}

function loadLocalFallback(
  logger: FastifyBaseLogger,
): LoadedReviewPipelineConfig {
  const rulesFallbackPath = resolveRulesFallbackPath();
  try {
    const content = readFileSync(rulesFallbackPath, "utf-8");
    const config = ReviewPipelineConfigSchema.parse({});
    return {
      ...config,
      pathRules: [{ extraRules: content, path: "**" }],
      rulesSource: "REVIEW.md (local)",
    };
  } catch {
    logger.warn(
      { path: rulesFallbackPath },
      "Local REVIEW.md not found; using defaults",
    );
    return {
      ...ReviewPipelineConfigSchema.parse({}),
      rulesSource: "REVIEW.md (local)",
    };
  }
}

class ReviewConfigLoader {
  constructor(
    private readonly codeHost: ICodeHost,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async load(
    projectId: number,
    headSha: string,
  ): Promise<LoadedReviewPipelineConfig> {
    const reviewMdContent = await this.tryFetchFile(
      projectId,
      headSha,
      "REVIEW.md",
    );

    if (reviewMdContent !== null) {
      const config = ReviewPipelineConfigSchema.parse({});
      return {
        ...config,
        pathRules: [{ extraRules: reviewMdContent, path: "**" }],
        rulesSource: "REVIEW.md (repo)",
      };
    }

    return loadLocalFallback(this.logger);
  }

  private async tryFetchFile(
    projectId: number,
    ref: string,
    path: string,
  ): Promise<string | null> {
    try {
      return await this.codeHost.getFileContent(projectId, ref, path);
    } catch (err) {
      if (err instanceof CodeHostNotFoundError) {
        return null;
      }
      this.logger.warn(
        { err, path, projectId, ref },
        "Failed to fetch file from repo",
      );
      return null;
    }
  }
}

export { ReviewConfigLoader };
