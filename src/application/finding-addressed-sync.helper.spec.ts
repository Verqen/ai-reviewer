import { describe, expect, it, vi } from "vitest";

import { unresolveDiscussionsAfterFailedPersist } from "~/application/finding-addressed-sync.helper";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import { createMockLogger } from "~/test-utils/mock-logger";

describe("unresolveDiscussionsAfterFailedPersist", () => {
  it("calls unresolve for each ref", async () => {
    const unresolveDiscussion = vi.fn(() => Promise.resolve());
    const codeHost = {
      unresolveDiscussion,
    } as unknown as ICodeHost;
    const logger = createMockLogger();
    await unresolveDiscussionsAfterFailedPersist(
      { codeHost, logger, mrIid: 7, projectId: 3 },
      [
        { discussionId: "d1", findingId: "f1" },
        { discussionId: "d2", findingId: "f2" },
      ]
    );
    expect(unresolveDiscussion).toHaveBeenCalledTimes(2);
    expect(unresolveDiscussion).toHaveBeenNthCalledWith(1, 3, 7, "d1");
    expect(unresolveDiscussion).toHaveBeenNthCalledWith(2, 3, 7, "d2");
  });

  it("continues after unresolve failure and logs", async () => {
    const unresolveDiscussion = vi
      .fn()
      .mockRejectedValueOnce(new Error("rollback failed"))
      .mockResolvedValueOnce(undefined);
    const codeHost = {
      unresolveDiscussion,
    } as unknown as ICodeHost;
    const logger = createMockLogger();
    const warnSpy = vi.spyOn(logger, "warn");
    await unresolveDiscussionsAfterFailedPersist(
      { codeHost, logger, mrIid: 1, projectId: 1 },
      [
        { discussionId: "d-bad", findingId: "f-bad" },
        { discussionId: "d-ok", findingId: "f-ok" },
      ]
    );
    expect(unresolveDiscussion).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });
});
