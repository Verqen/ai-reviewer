import { describe, expect, it, vi } from "vitest";

import type { ICodeHost } from "~/domain/ports/code-host.port";
import { CodeHostNotFoundError } from "~/domain/types/code-host.types";
import { createMockLogger } from "~/test-utils/mock-logger";

import { detectIncrementalTrigger } from "./detect-incremental-trigger";

function makeCodeHost(
  getCommitRangeDiff: ICodeHost["getCommitRangeDiff"],
): ICodeHost {
  return { getCommitRangeDiff } as unknown as ICodeHost;
}

describe("detectIncrementalTrigger", () => {
  const projectId = 42;
  const previousSha = "old-head-sha";
  const newHeadSha = "new-head-sha";

  it("returns 'rebase' when MR base SHA changed since previous run", async () => {
    const getCommitRangeDiff = vi.fn();
    const codeHost = makeCodeHost(getCommitRangeDiff);
    const result = await detectIncrementalTrigger(
      codeHost,
      projectId,
      previousSha,
      newHeadSha,
      createMockLogger(),
      {
        currentBaseSha: "main-tip-new",
        previousBaseSha: "main-tip-old",
      },
    );
    expect(result).toBe("rebase");
    expect(getCommitRangeDiff).not.toHaveBeenCalled();
  });

  it("returns 'push' when base SHA unchanged and commit range is reachable", async () => {
    const getCommitRangeDiff = vi.fn().mockResolvedValue([]);
    const codeHost = makeCodeHost(getCommitRangeDiff);
    const result = await detectIncrementalTrigger(
      codeHost,
      projectId,
      previousSha,
      newHeadSha,
      createMockLogger(),
      {
        currentBaseSha: "main-tip",
        previousBaseSha: "main-tip",
      },
    );
    expect(result).toBe("push");
    expect(getCommitRangeDiff).toHaveBeenCalledWith(
      projectId,
      previousSha,
      newHeadSha,
      { straight: true },
    );
  });

  it("returns 'force_push' when base SHA unchanged and previous SHA is unreachable (404)", async () => {
    const codeHost = makeCodeHost(
      vi.fn().mockRejectedValue(new CodeHostNotFoundError("not found")),
    );
    const result = await detectIncrementalTrigger(
      codeHost,
      projectId,
      previousSha,
      newHeadSha,
      createMockLogger(),
      {
        currentBaseSha: "main-tip",
        previousBaseSha: "main-tip",
      },
    );
    expect(result).toBe("force_push");
  });

  it("falls back to legacy behaviour (push) when no base SHA hints provided", async () => {
    const codeHost = makeCodeHost(vi.fn().mockResolvedValue([]));
    const result = await detectIncrementalTrigger(
      codeHost,
      projectId,
      previousSha,
      newHeadSha,
      createMockLogger(),
    );
    expect(result).toBe("push");
  });

  it("treats empty base SHA strings as 'no hint' and falls through to push detection", async () => {
    const codeHost = makeCodeHost(vi.fn().mockResolvedValue([]));
    const result = await detectIncrementalTrigger(
      codeHost,
      projectId,
      previousSha,
      newHeadSha,
      createMockLogger(),
      {
        currentBaseSha: "",
        previousBaseSha: "",
      },
    );
    expect(result).toBe("push");
  });

  it("rethrows a generic error instead of guessing the trigger type", async () => {
    const codeHost = makeCodeHost(
      vi.fn().mockRejectedValue(new Error("network blew up")),
    );
    await expect(
      detectIncrementalTrigger(
        codeHost,
        projectId,
        previousSha,
        newHeadSha,
        createMockLogger(),
      ),
    ).rejects.toThrow("network blew up");
  });
});
