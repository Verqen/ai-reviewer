import type { FastifyBaseLogger } from "fastify";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";

function isNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("404") || err.message.includes("not found"))
  );
}

function isUnreachableCommitRangeError(err: unknown): boolean {
  return err instanceof CodeHostNotFoundError || isNotFoundError(err);
}

interface DetectIncrementalTriggerOptions {
  currentBaseSha?: string | undefined;
  previousBaseSha?: string | undefined;
}

async function detectIncrementalTrigger(
  codeHost: ICodeHost,
  projectId: number,
  previousSha: string,
  newHeadSha: string,
  logger: FastifyBaseLogger,
  options: DetectIncrementalTriggerOptions = {},
): Promise<"force_push" | "push" | "rebase"> {
  const { currentBaseSha, previousBaseSha } = options;
  if (
    previousBaseSha !== undefined &&
    currentBaseSha !== undefined &&
    previousBaseSha.length > 0 &&
    currentBaseSha.length > 0 &&
    previousBaseSha !== currentBaseSha
  ) {
    logger.info(
      { currentBaseSha, mrIid: projectId, previousBaseSha, projectId },
      "Rebase detected: MR base SHA changed since previous review",
    );
    return "rebase";
  }
  try {
    await codeHost.getCommitRangeDiff(projectId, previousSha, newHeadSha, {
      straight: true,
    });
    return "push";
  } catch (err) {
    if (isUnreachableCommitRangeError(err)) {
      logger.info(
        { newHeadSha, previousSha, projectId },
        "Force-push detected: old SHA not found in repo",
      );
      return "force_push";
    }
    logger.warn(
      { err, newHeadSha, previousSha, projectId },
      "Error checking commit range; treating as force-push",
    );
    return "force_push";
  }
}

export { detectIncrementalTrigger, isUnreachableCommitRangeError };
export type { DetectIncrementalTriggerOptions };
