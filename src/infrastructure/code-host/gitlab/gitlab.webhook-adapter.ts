import { z } from "zod";

import type { WebhookEvent } from "~/domain/types/code-host.types";

type GitlabWebhookParseResult =
  | { kind: "event"; event: WebhookEvent }
  | {
      kind: "ignored";
      reason: "draft_merge_request" | "merge_request_terminal";
    }
  | { kind: "invalid" };

const GitLabMrWebhookSchema = z.object({
  changes: z
    .object({
      draft: z
        .object({
          current: z.boolean(),
          previous: z.boolean(),
        })
        .optional(),
    })
    .optional(),
  object_attributes: z.object({
    action: z.string(),
    draft: z.boolean().optional(),
    iid: z.number(),
    last_commit: z.object({ id: z.string() }).optional(),
    oldrev: z.string().optional(),
    state: z.enum(["opened", "closed", "locked", "merged"]).optional(),
    work_in_progress: z.boolean().optional(),
  }),
  object_kind: z.literal("merge_request"),
  project: z.object({
    id: z.number(),
  }),
});

const GitLabNoteWebhookSchema = z.object({
  merge_request: z
    .object({
      draft: z.boolean().optional(),
      iid: z.number(),
    })
    .nullable()
    .optional(),
  object_attributes: z.object({
    discussion_id: z.string().nullable().optional(),
    note: z.string(),
    noteable_type: z.string(),
    position: z
      .object({
        new_line: z.number().nullable().optional(),
        new_path: z.string().optional(),
        old_line: z.number().nullable().optional(),
        old_path: z.string().optional(),
      })
      .nullable()
      .optional(),
  }),
  object_kind: z.literal("note"),
  project: z.object({
    id: z.number(),
  }),
  user: z.object({
    username: z.string(),
  }),
});

const GitLabPushWebhookSchema = z.object({
  after: z.string(),
  before: z.string(),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).default([]),
        modified: z.array(z.string()).default([]),
        removed: z.array(z.string()).default([]),
      })
    )
    .default([]),
  object_kind: z.literal("push"),
  project: z.object({
    id: z.number(),
  }),
  ref: z.string(),
});

type GitLabMrWebhook = z.infer<typeof GitLabMrWebhookSchema>;
type GitLabNoteWebhook = z.infer<typeof GitLabNoteWebhookSchema>;
type GitLabPushWebhook = z.infer<typeof GitLabPushWebhookSchema>;

function isMrPayloadDraft(
  objectAttributes: {
    draft?: boolean | undefined;
    work_in_progress?: boolean | undefined;
  },
  changes:
    | { draft?: { current: boolean; previous: boolean } | undefined }
    | undefined
): boolean {
  if (objectAttributes.draft === true) {
    return true;
  }
  if (objectAttributes.work_in_progress === true) {
    return true;
  }
  if (changes?.draft?.current === true) {
    return true;
  }
  return false;
}

function parseGitLabWebhook(body: unknown): GitlabWebhookParseResult {
  if (typeof body !== "object" || body === null) {
    return { kind: "invalid" };
  }

  const kind = (body as Record<string, unknown>)["object_kind"];

  if (kind === "merge_request") {
    return parseMrEvent(body);
  }

  if (kind === "note") {
    return parseNoteEvent(body);
  }

  if (kind === "push") {
    const event = parsePushEvent(body);
    if (!event) {
      return { kind: "invalid" };
    }
    return { event, kind: "event" };
  }

  return { kind: "invalid" };
}

function parseMrEvent(body: unknown): GitlabWebhookParseResult {
  const result = GitLabMrWebhookSchema.safeParse(body);

  if (!result.success) {
    return { kind: "invalid" };
  }

  const { changes, object_attributes, project } = result.data;
  const { action, iid, last_commit, state } = object_attributes;
  const headSha = last_commit?.id;

  if (action === "close" || action === "merge") {
    return { kind: "ignored", reason: "merge_request_terminal" };
  }

  if (action === "update" && (state === "closed" || state === "merged")) {
    return { kind: "ignored", reason: "merge_request_terminal" };
  }

  const exitedDraft =
    changes?.draft?.previous === true && changes?.draft?.current === false;

  const isDraft = isMrPayloadDraft(object_attributes, changes);

  if ((action === "open" || action === "update") && !headSha) {
    return { kind: "invalid" };
  }

  if (!headSha) {
    return { kind: "invalid" };
  }

  const resolvedHeadSha = headSha;

  if (action === "open") {
    if (isDraft) {
      return { kind: "ignored", reason: "draft_merge_request" };
    }
    return {
      event: {
        headSha: resolvedHeadSha,
        mrIid: iid,
        projectId: project.id,
        type: "mr_open",
      },
      kind: "event",
    };
  }

  if (action === "update" && exitedDraft) {
    return {
      event: {
        headSha: resolvedHeadSha,
        mrIid: iid,
        projectId: project.id,
        type: "mr_undraft",
      },
      kind: "event",
    };
  }

  if (action === "update" && isDraft) {
    return { kind: "ignored", reason: "draft_merge_request" };
  }

  if (action === "update") {
    return {
      event: {
        headSha: resolvedHeadSha,
        mrIid: iid,
        previousHeadSha: object_attributes.oldrev,
        projectId: project.id,
        type: "mr_update",
      },
      kind: "event",
    };
  }

  return { kind: "invalid" };
}

function parseNoteEvent(body: unknown): GitlabWebhookParseResult {
  const result = GitLabNoteWebhookSchema.safeParse(body);

  if (!result.success) {
    return { kind: "invalid" };
  }

  const { merge_request, object_attributes, project, user } = result.data;

  if (!merge_request) {
    return { kind: "invalid" };
  }

  if (merge_request.draft !== false) {
    return { kind: "ignored", reason: "draft_merge_request" };
  }

  return {
    event: {
      authorUsername: user.username,
      discussionId: object_attributes.discussion_id ?? undefined,
      mrIid: merge_request.iid,
      note: object_attributes.note,
      position: object_attributes.position
        ? {
            newLine: object_attributes.position.new_line ?? undefined,
            newPath: object_attributes.position.new_path,
            oldLine: object_attributes.position.old_line ?? undefined,
            oldPath: object_attributes.position.old_path,
          }
        : undefined,
      projectId: project.id,
      type: "note",
    },
    kind: "event",
  };
}

function parsePushEvent(body: unknown): WebhookEvent | null {
  const result = GitLabPushWebhookSchema.safeParse(body);

  if (!result.success) {
    return null;
  }

  const { after, before, commits, project, ref } = result.data;

  return {
    afterSha: after,
    beforeSha: before,
    commits,
    projectId: project.id,
    ref,
    type: "push",
  };
}

export { parseGitLabWebhook };
export type {
  GitLabMrWebhook,
  GitLabNoteWebhook,
  GitLabPushWebhook,
  GitlabWebhookParseResult,
};
