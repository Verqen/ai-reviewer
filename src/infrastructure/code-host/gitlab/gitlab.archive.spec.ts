import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabCodeHost } from "~/infrastructure/code-host/gitlab/gitlab.code-host";
import { createMockLogger } from "~/test-utils/mock-logger";

type FakeResponse = PassThrough & { statusCode: number };

interface CapturedGet {
  onResponse: (response: FakeResponse) => void;
  options: RequestOptions;
}

const captured: CapturedGet[] = [];

vi.mock("node:https", () => ({
  get: (
    _url: string,
    options: RequestOptions,
    onResponse: (response: FakeResponse) => void,
  ) => {
    captured.push({ onResponse, options });
    return Object.assign(new EventEmitter(), { destroy: vi.fn() });
  },
}));

function buildCodeHost(): GitLabCodeHost {
  return new GitLabCodeHost(
    {
      envs: {
        GITLAB_API_URL: "https://gitlab.example.com/api/v4",
        GITLAB_BOT_USERNAME: "ai",
        GITLAB_TOKEN: "test-token",
      },
    },
    createMockLogger(),
  );
}

function lastGet(): CapturedGet {
  const last = captured.at(-1);
  if (last === undefined) {
    throw new Error("expected an archive request");
  }
  return last;
}

describe("GitLabCodeHost.getRepositoryArchive transport", () => {
  afterEach(() => {
    captured.length = 0;
  });

  it("bounds the archive request with an abort signal", async () => {
    const pending = buildCodeHost().getRepositoryArchive(42, "main");
    const { onResponse, options } = lastGet();

    expect(options.signal).toBeInstanceOf(AbortSignal);

    onResponse(Object.assign(new PassThrough(), { statusCode: 404 }));
    await expect(pending).rejects.toThrow();
  });

  it("rejects when the response stream fails mid-download", async () => {
    const pending = buildCodeHost().getRepositoryArchive(42, "main");
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    lastGet().onResponse(response);

    response.destroy(new Error("socket hang up"));

    await expect(pending).rejects.toThrow("socket hang up");
  });
});
