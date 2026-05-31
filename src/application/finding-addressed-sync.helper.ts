import type { FastifyBaseLogger } from "fastify";

import type { ICodeHost } from "~/domain/ports/code-host.port";

interface AddressedSyncHostContext {
  readonly codeHost: ICodeHost;
  readonly logger: FastifyBaseLogger;
  readonly mrIid: number;
  readonly projectId: number;
}

interface DiscussionRollbackRef {
  readonly discussionId: string;
  readonly findingId: string;
}

async function unresolveDiscussionsAfterFailedPersist(
  ctx: AddressedSyncHostContext,
  refs: readonly DiscussionRollbackRef[]
): Promise<void> {
  for (const ref of refs) {
    try {
      await ctx.codeHost.unresolveDiscussion(
        ctx.projectId,
        ctx.mrIid,
        ref.discussionId
      );
    } catch (rollbackErr) {
      ctx.logger.warn(
        {
          discussionId: ref.discussionId,
          err: rollbackErr,
          findingId: ref.findingId,
        },
        "Failed to rollback discussion resolution after DB update failure"
      );
    }
  }
}

export { unresolveDiscussionsAfterFailedPersist };
