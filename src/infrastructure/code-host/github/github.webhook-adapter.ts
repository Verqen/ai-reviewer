import { z } from "zod";

import type { WebhookEvent } from "~/domain/types/code-host.types";

type GitHubWebhookParseResult =
  | { kind: "event"; event: WebhookEvent }
  | {
      kind: "ignored";
      reason: "draft_merge_request" | "merge_request_terminal";
    }
  | { kind: "invalid" };

const GitHubPullRequestSchema = z.object({
  action: z.string(),
  before: z.string().optional(),
  number: z.number(),
  pull_request: z.object({
    base: z.object({ ref: z.string() }),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
  repository: z.object({ id: z.number() }),
});

const GitHubIssueCommentSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string() }),
  }),
  issue: z.object({
    number: z.number(),
    pull_request: z.object({}).optional(),
  }),
  repository: z.object({ id: z.number() }),
});

const GitHubReviewCommentSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    id: z.number(),
    in_reply_to_id: z.number().optional(),
    line: z.number().nullable().optional(),
    path: z.string(),
    side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
    user: z.object({ login: z.string() }),
  }),
  pull_request: z.object({ draft: z.boolean().optional(), number: z.number() }),
  repository: z.object({ id: z.number() }),
});

const GitHubPushSchema = z.object({
  after: z.string(),
  before: z.string(),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).default([]),
        modified: z.array(z.string()).default([]),
        removed: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  ref: z.string(),
  repository: z.object({ id: z.number() }),
});

function parseGitHubWebhook(
  eventName: string,
  body: unknown,
): GitHubWebhookParseResult {
  if (eventName === "pull_request") {
    return parsePullRequestEvent(body);
  }
  if (eventName === "issue_comment") {
    return parseIssueCommentEvent(body);
  }
  if (eventName === "pull_request_review_comment") {
    return parseReviewCommentEvent(body);
  }
  if (eventName === "push") {
    return parsePushEvent(body);
  }
  return { kind: "invalid" };
}

function parsePullRequestEvent(body: unknown): GitHubWebhookParseResult {
  const result = GitHubPullRequestSchema.safeParse(body);
  if (!result.success) {
    return { kind: "invalid" };
  }
  const { action, before, number, pull_request, repository } = result.data;
  const headSha = pull_request.head.sha;
  const isDraft = pull_request.draft === true;

  if (action === "closed") {
    return { kind: "ignored", reason: "merge_request_terminal" };
  }

  if (action === "opened" || action === "reopened") {
    if (isDraft) {
      return { kind: "ignored", reason: "draft_merge_request" };
    }
    return {
      event: {
        headSha,
        mrIid: number,
        projectId: repository.id,
        type: "mr_open",
      },
      kind: "event",
    };
  }

  if (action === "ready_for_review") {
    return {
      event: {
        headSha,
        mrIid: number,
        projectId: repository.id,
        type: "mr_undraft",
      },
      kind: "event",
    };
  }

  if (action === "synchronize") {
    if (isDraft) {
      return { kind: "ignored", reason: "draft_merge_request" };
    }
    return {
      event: {
        headSha,
        mrIid: number,
        previousHeadSha: before,
        projectId: repository.id,
        type: "mr_update",
      },
      kind: "event",
    };
  }

  return { kind: "invalid" };
}

function parseIssueCommentEvent(body: unknown): GitHubWebhookParseResult {
  const result = GitHubIssueCommentSchema.safeParse(body);
  if (!result.success) {
    return { kind: "invalid" };
  }
  const { action, comment, issue, repository } = result.data;
  if (action !== "created" || !issue.pull_request) {
    return { kind: "invalid" };
  }
  return {
    event: {
      authorUsername: comment.user.login,
      mrIid: issue.number,
      note: comment.body,
      projectId: repository.id,
      type: "note",
    },
    kind: "event",
  };
}

function parseReviewCommentEvent(body: unknown): GitHubWebhookParseResult {
  const result = GitHubReviewCommentSchema.safeParse(body);
  if (!result.success) {
    return { kind: "invalid" };
  }
  const { action, comment, pull_request, repository } = result.data;
  if (action !== "created") {
    return { kind: "invalid" };
  }
  if (pull_request.draft === true) {
    return { kind: "ignored", reason: "draft_merge_request" };
  }
  const onNewSide = comment.side !== "LEFT";
  const line = comment.line ?? undefined;
  return {
    event: {
      authorUsername: comment.user.login,
      discussionId: String(comment.in_reply_to_id ?? comment.id),
      mrIid: pull_request.number,
      note: comment.body,
      position: {
        newLine: onNewSide ? line : undefined,
        newPath: onNewSide ? comment.path : undefined,
        oldLine: onNewSide ? undefined : line,
        oldPath: onNewSide ? undefined : comment.path,
      },
      projectId: repository.id,
      type: "note",
    },
    kind: "event",
  };
}

function parsePushEvent(body: unknown): GitHubWebhookParseResult {
  const result = GitHubPushSchema.safeParse(body);
  if (!result.success) {
    return { kind: "invalid" };
  }
  const { after, before, commits, ref, repository } = result.data;
  return {
    event: {
      afterSha: after,
      beforeSha: before,
      commits,
      projectId: repository.id,
      ref,
      type: "push",
    },
    kind: "event",
  };
}

export { parseGitHubWebhook };
export type { GitHubWebhookParseResult };
