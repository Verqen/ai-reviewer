import { createHash } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

type BaselineReviewWaitLimits = {
  pollMs: number;
  timeoutMs: number;
};

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

class BaselineService {
  private readonly baselineReviewPollMs: number;

  private readonly baselineReviewReadyTimeoutMs: number;

  constructor(
    private readonly snapshotRepo: ISnapshotRepository,
    private readonly codeHost: ICodeHost,
    private readonly logger: FastifyBaseLogger,
    baselineReviewWaitLimits?: BaselineReviewWaitLimits,
  ) {
    this.baselineReviewPollMs = baselineReviewWaitLimits?.pollMs ?? 400;
    this.baselineReviewReadyTimeoutMs =
      baselineReviewWaitLimits?.timeoutMs ?? 900_000;
  }

  async bootstrap(projectId: number): Promise<void> {
    this.logger.info({ projectId }, "Starting baseline bootstrap");

    const defaultBranch = await this.codeHost.getDefaultBranch(projectId);
    const tree = await this.codeHost.getFileTree(projectId, defaultBranch);

    if (tree.length === 0) {
      throw new Error(`Empty file tree for project ${projectId}`);
    }

    const commitSha = await this.codeHost.getBranchHeadSha(
      projectId,
      defaultBranch,
    );

    await this.snapshotRepo.setBaselineState(
      projectId,
      commitSha,
      "bootstrapping",
    );

    try {
      const archiveEntries = await this.codeHost.getRepositoryArchive(
        projectId,
        defaultBranch,
      );

      const blobs: Array<{ hash: string; content: Buffer }> = [];
      const entries: Array<{ blobHash: string; filePath: string }> = [];
      const seenHashes = new Set<string>();

      for (const entry of archiveEntries) {
        const hash = hashContent(entry.content);

        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          blobs.push({ content: entry.content, hash });
        }

        entries.push({ blobHash: hash, filePath: entry.path });
      }

      await this.snapshotRepo.storeBlobs(blobs);
      await this.snapshotRepo.storeSnapshot({
        commitSha,
        entries,
        projectId,
      });

      await this.snapshotRepo.setBaselineState(projectId, commitSha, "ready");

      this.logger.info(
        { blobCount: blobs.length, fileCount: entries.length, projectId },
        "Baseline bootstrap complete",
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.snapshotRepo.setBaselineState(
        projectId,
        commitSha,
        "failed",
        errorMessage,
      );

      throw err;
    }
  }

  async update(
    projectId: number,
    commitSha: string,
    changedFiles: string[],
  ): Promise<void> {
    this.logger.info(
      { changedCount: changedFiles.length, commitSha, projectId },
      "Updating baseline",
    );

    const baseline = await this.snapshotRepo.getBaselineState(projectId);

    if (!baseline || baseline.status !== "ready") {
      this.logger.warn(
        { projectId, status: baseline?.status },
        "No ready baseline; triggering bootstrap instead",
      );
      return this.bootstrap(projectId);
    }

    const oldCommitSha = baseline.commitSha;

    if (oldCommitSha === commitSha) {
      this.logger.info({ commitSha, projectId }, "Baseline already at target");
      return;
    }

    const blobs: Array<{ hash: string; content: Buffer }> = [];
    const newEntries: Array<{ blobHash: string; filePath: string }> = [];
    const deletedPaths = new Set<string>();
    const changedPathSet = new Set(changedFiles);
    const seenHashes = new Set<string>();

    for (const filePath of changedFiles) {
      try {
        const content = await this.codeHost.getFileContent(
          projectId,
          commitSha,
          filePath,
        );
        const contentBuffer = Buffer.from(content, "utf-8");
        const hash = hashContent(contentBuffer);

        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          blobs.push({ content: contentBuffer, hash });
        }

        newEntries.push({ blobHash: hash, filePath });
      } catch {
        deletedPaths.add(filePath);
      }
    }

    const excludePaths = new Set([...changedPathSet, ...deletedPaths]);

    await this.snapshotRepo.storeSnapshot({
      commitSha,
      entries: [],
      projectId,
    });

    const copiedCount = await this.snapshotRepo.copySnapshotEntries(
      projectId,
      oldCommitSha,
      commitSha,
      excludePaths,
    );

    if (blobs.length > 0) {
      await this.snapshotRepo.storeBlobs(blobs);
    }

    if (newEntries.length > 0) {
      await this.snapshotRepo.storeSnapshot({
        commitSha,
        entries: newEntries,
        projectId,
      });
    }

    await this.snapshotRepo.setBaselineState(projectId, commitSha, "ready");
    await this.snapshotRepo.deleteCommit(projectId, oldCommitSha);

    this.logger.info(
      {
        copiedCount,
        deletedCount: deletedPaths.size,
        newBlobCount: blobs.length,
        projectId,
      },
      "Baseline update complete",
    );
  }

  async executeWaitUntilBaselineReadyForReview(
    projectId: number,
  ): Promise<void> {
    const deadline = Date.now() + this.baselineReviewReadyTimeoutMs;
    while (Date.now() < deadline) {
      const baseline = await this.snapshotRepo.getBaselineState(projectId);
      if (baseline?.status === "ready") {
        return;
      }
      if (baseline?.status === "failed") {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.baselineReviewPollMs);
      });
    }
    this.logger.warn(
      {
        projectId,
        timeoutMs: this.baselineReviewReadyTimeoutMs,
      },
      "Baseline not ready before review wait deadline; proceeding without codebase exploration",
    );
  }
}

export { BaselineService };
