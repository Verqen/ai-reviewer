import type { FastifyBaseLogger } from "fastify";

import type { ICache } from "~/domain/ports/cache.port";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";

type WebhookOrchestrationConflictReason =
  | "response_in_progress"
  | "review_in_progress";

type WebhookOrchestrationResult =
  | { kind: "accepted" }
  | { kind: "conflict"; reason: WebhookOrchestrationConflictReason }
  | { kind: "ignored" };

interface WebhookOrchestratorDeps {
  botUsername: string;
  cache: ICache<boolean>;
  codeHost: ICodeHost;
  jobHandler: (job: ReviewJob) => Promise<void>;
  log: FastifyBaseLogger;
  queue: IJobQueue<ReviewJob>;
  reviewFindingRepo: IReviewFindingRepository;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
}

interface WebhookOrchestrator {
  handleEvent: (event: WebhookEvent) => Promise<WebhookOrchestrationResult>;
}

export type {
  WebhookOrchestrationConflictReason,
  WebhookOrchestrationResult,
  WebhookOrchestrator,
  WebhookOrchestratorDeps,
};
