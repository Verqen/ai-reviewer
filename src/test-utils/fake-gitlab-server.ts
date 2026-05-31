import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

function loadFixture<T>(name: string): T {
  const filePath = path.join(__dirname, "fixtures", `${name}.json`);
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

interface PostedComment {
  body: string;
  mrIid: number;
  position: Record<string, unknown>;
  projectId: number;
}

interface PostedNote {
  body: string;
  mrIid: number;
  projectId: number;
}

interface PostedReply {
  body: string;
  discussionId: string;
  mrIid: number;
  projectId: number;
}

interface ResolvedDiscussion {
  discussionId: string;
  mrIid: number;
  projectId: number;
}

interface ApprovalAction {
  action: "approve" | "unapprove";
  mrIid: number;
  projectId: number;
}

interface FakeGitLabServer {
  getApprovalActions(): ApprovalAction[];
  getPostedComments(): PostedComment[];
  getPostedNotes(): PostedNote[];
  getPostedReplies(): PostedReply[];
  getResolvedDiscussions(): ResolvedDiscussion[];
  isApproved(projectId: number, mrIid: number): boolean;
  reset(): void;
  start(): Promise<string>;
  stop(): Promise<void>;
}

function createFakeGitLabServer(): FakeGitLabServer {
  const app: FastifyInstance = Fastify({ logger: false });

  let postedComments: PostedComment[] = [];
  let postedNotes: PostedNote[] = [];
  let postedReplies: PostedReply[] = [];
  let resolvedDiscussions: ResolvedDiscussion[] = [];
  let approvalActions: ApprovalAction[] = [];
  const approvals = new Set<string>();

  const approvalKey = (projectId: number, mrIid: number): string =>
    `${projectId}:${mrIid}`;

  const getMrPayload = (): Record<string, unknown> => {
    const mrData = loadFixture<Record<string, unknown>>("mr-open");
    return {
      description: "Implements JWT-based authentication",
      iid: 7,
      project_id: 42,
      source_branch: "feature/auth",
      target_branch: "main",
      title: "Add user authentication",
      ...((mrData["object_attributes"] as Record<string, unknown>) ?? {}),
    };
  };

  const registerRoutes = (prefix: string): void => {
    app.get(`${prefix}/projects/:projectId`, (_req, reply) => {
      return reply.send({ default_branch: "main", id: 42 });
    });

    app.get(
      `${prefix}/projects/:projectId/merge_requests/:mrIid`,
      (_req, reply) => {
        return reply.send(getMrPayload());
      },
    );

    app.get(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/changes`,
      (_req, reply) => {
        const diffs = loadFixture<unknown[]>("mr-diff");
        return reply.send({ changes: diffs });
      },
    );

    app.get(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/versions`,
      (_req, reply) => {
        const versions = loadFixture<unknown[]>("mr-versions");
        return reply.send(versions);
      },
    );

    app.get(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/discussions/:discussionId`,
      (_req, reply) => {
        return reply.send({
          id: "disc-abc123",
          notes: [
            {
              author: { username: "developer1" },
              body: "What about password hashing?",
            },
          ],
        });
      },
    );

    app.get(
      `${prefix}/projects/:projectId/repository/branches/:branch`,
      (_req, reply) => {
        return reply.send({ commit: { id: "abc123def456" } });
      },
    );

    app.get(`${prefix}/projects/:projectId/repository/tree`, (_req, reply) => {
      const tree = loadFixture<unknown[]>("file-tree");
      return reply.send(tree);
    });

    app.get(
      `${prefix}/projects/:projectId/repository/files/:filePath/raw`,
      (_req, reply) => {
        return reply.status(404).send({ message: "404 File Not Found" });
      },
    );

    app.get(
      `${prefix}/projects/:projectId/repository/compare`,
      (_req, reply) => {
        return reply.send({ diffs: [] });
      },
    );

    app.get(`${prefix}/projects/:projectId/merge_requests`, (_req, reply) => {
      return reply.send([]);
    });

    app.post(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/discussions`,
      (req, reply) => {
        const params = req.params as { mrIid: string; projectId: string };
        const body = req.body as {
          body: string;
          position: Record<string, unknown>;
        };

        postedComments.push({
          body: body.body,
          mrIid: Number(params.mrIid),
          position: body.position ?? {},
          projectId: Number(params.projectId),
        });

        return reply.status(201).send({
          id: `disc-${postedComments.length}`,
          notes: [{ id: `note-${postedComments.length}` }],
        });
      },
    );

    app.post(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/notes`,
      (req, reply) => {
        const params = req.params as { mrIid: string; projectId: string };
        const body = req.body as { body: string };

        postedNotes.push({
          body: body.body,
          mrIid: Number(params.mrIid),
          projectId: Number(params.projectId),
        });

        return reply.status(201).send({ id: `note-${postedNotes.length}` });
      },
    );

    app.post(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/discussions/:discussionId/notes`,
      (req, reply) => {
        const params = req.params as {
          discussionId: string;
          mrIid: string;
          projectId: string;
        };
        const body = req.body as { body: string };

        postedReplies.push({
          body: body.body,
          discussionId: params.discussionId,
          mrIid: Number(params.mrIid),
          projectId: Number(params.projectId),
        });

        return reply
          .status(201)
          .send({ id: `note-reply-${postedReplies.length}` });
      },
    );

    app.put(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/discussions/:discussionId`,
      (req, reply) => {
        const params = req.params as {
          discussionId: string;
          mrIid: string;
          projectId: string;
        };

        resolvedDiscussions.push({
          discussionId: params.discussionId,
          mrIid: Number(params.mrIid),
          projectId: Number(params.projectId),
        });

        return reply.send({ id: params.discussionId, resolved: true });
      },
    );

    app.post(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/approve`,
      (req, reply) => {
        const params = req.params as { mrIid: string; projectId: string };
        const projectId = Number(params.projectId);
        const mrIid = Number(params.mrIid);

        approvals.add(approvalKey(projectId, mrIid));
        approvalActions.push({ action: "approve", mrIid, projectId });

        return reply.status(201).send({ approved: true });
      },
    );

    app.post(
      `${prefix}/projects/:projectId/merge_requests/:mrIid/unapprove`,
      (req, reply) => {
        const params = req.params as { mrIid: string; projectId: string };
        const projectId = Number(params.projectId);
        const mrIid = Number(params.mrIid);

        approvals.delete(approvalKey(projectId, mrIid));
        approvalActions.push({ action: "unapprove", mrIid, projectId });

        return reply.status(201).send({ approved: false });
      },
    );
  };

  registerRoutes("/api/v4");
  registerRoutes("");

  return {
    getApprovalActions(): ApprovalAction[] {
      return [...approvalActions];
    },

    getPostedComments(): PostedComment[] {
      return [...postedComments];
    },

    getPostedNotes(): PostedNote[] {
      return [...postedNotes];
    },

    getPostedReplies(): PostedReply[] {
      return [...postedReplies];
    },

    getResolvedDiscussions(): ResolvedDiscussion[] {
      return [...resolvedDiscussions];
    },

    isApproved(projectId: number, mrIid: number): boolean {
      return approvals.has(approvalKey(projectId, mrIid));
    },

    reset(): void {
      approvalActions = [];
      approvals.clear();
      postedComments = [];
      postedNotes = [];
      postedReplies = [];
      resolvedDiscussions = [];
    },

    async start(): Promise<string> {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return `http://127.0.0.1:${port}/`;
    },

    async stop(): Promise<void> {
      await app.close();
    },
  };
}

export { createFakeGitLabServer, loadFixture };

export type {
  ApprovalAction,
  FakeGitLabServer,
  PostedComment,
  PostedNote,
  PostedReply,
  ResolvedDiscussion,
};
