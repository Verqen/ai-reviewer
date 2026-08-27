import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installGitHubResilience,
  isRetryableError,
  retryAfterMs,
  withRequestTimeout,
} from "./github-resilience";

interface StubResponse {
  headers?: Record<string, string>;
  status: number;
}

interface RecordedRequest {
  hasSignal: boolean;
  method: string;
}

function buildOctokit(responses: StubResponse[]): {
  octokit: Octokit;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      hasSignal: init?.signal != null,
      method: init?.method ?? "GET",
    });
    const stub = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = stub?.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: status < 400 }), {
        headers: { "content-type": "application/json", ...stub?.headers },
        status,
      }),
    );
  };

  const octokit = installGitHubResilience(
    new Octokit({
      auth: "test",
      request: { fetch: withRequestTimeout(fetchImpl) },
    }),
  );
  return { octokit, requests };
}

function rateLimitedForbidden(): StubResponse {
  return {
    headers: { "retry-after": "1", "x-ratelimit-remaining": "0" },
    status: 403,
  };
}

function permissionDenied(): StubResponse {
  return { headers: { "x-ratelimit-remaining": "4321" }, status: 403 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isRetryableError", () => {
  it("treats a 403 with an exhausted rate limit as retryable", () => {
    const error = {
      response: { headers: { "x-ratelimit-remaining": "0" } },
      status: 403,
    };
    expect(isRetryableError("GET", error)).toBe(true);
    expect(isRetryableError("POST", error)).toBe(true);
  });

  it("treats a 403 carrying retry-after as retryable", () => {
    const error = {
      response: { headers: { "retry-after": "30" } },
      status: 403,
    };
    expect(isRetryableError("GET", error)).toBe(true);
  });

  it("treats a 403 with quota left as a permanent permission failure", () => {
    const error = {
      response: { headers: { "x-ratelimit-remaining": "4999" } },
      status: 403,
    };
    expect(isRetryableError("GET", error)).toBe(false);
  });

  it("treats a 403 without rate-limit headers as permanent", () => {
    expect(isRetryableError("GET", { status: 403 })).toBe(false);
  });

  it("retries 429 for any method", () => {
    expect(isRetryableError("POST", { status: 429 })).toBe(true);
  });

  it("retries server errors only for idempotent methods", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableError("GET", { status })).toBe(true);
      expect(isRetryableError("POST", { status })).toBe(false);
    }
  });

  it("does not retry deterministic client errors", () => {
    for (const status of [400, 401, 404, 422]) {
      expect(isRetryableError("GET", { status })).toBe(false);
    }
  });

  it("does not retry an error without a status", () => {
    expect(isRetryableError("GET", new Error("boom"))).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("honors a retry-after header in seconds, capped", () => {
    const error = { response: { headers: { "retry-after": "5" } } };
    expect(retryAfterMs(error, 0)).toBe(5000);
    const huge = { response: { headers: { "retry-after": "9999" } } };
    expect(retryAfterMs(huge, 0)).toBe(20000);
  });

  it("honors x-ratelimit-reset as an absolute epoch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const resetEpoch = 1_700_000_000 + 4;
    const error = {
      response: { headers: { "x-ratelimit-reset": String(resetEpoch) } },
    };
    expect(retryAfterMs(error, 0)).toBe(4000);
  });

  it("falls back to exponential backoff with jitter within bounds", () => {
    const error = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      const ms = retryAfterMs(error, attempt);
      expect(ms).toBeGreaterThanOrEqual(1000 * 2 ** attempt);
      expect(ms).toBeLessThanOrEqual(20000);
    }
  });
});

describe("installGitHubResilience", () => {
  it("retries a rate-limited 403 and returns the eventual success", async () => {
    vi.useFakeTimers();
    const { octokit, requests } = buildOctokit([
      rateLimitedForbidden(),
      rateLimitedForbidden(),
      { status: 200 },
    ]);

    const pending = octokit.request("GET /rate_limit");
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(3);
  });

  it("fails a permission 403 on the first attempt", async () => {
    const { octokit, requests } = buildOctokit([permissionDenied()]);

    await expect(octokit.request("GET /rate_limit")).rejects.toMatchObject({
      status: 403,
    });
    expect(requests).toHaveLength(1);
  });

  it("retries a server error for a GET until the budget is spent", async () => {
    vi.useFakeTimers();
    const { octokit, requests } = buildOctokit([{ status: 500 }]);

    const pending = octokit.request("GET /rate_limit");
    const assertion = expect(pending).rejects.toMatchObject({ status: 500 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(requests).toHaveLength(4);
  });

  it("does not retry a server error for a POST", async () => {
    const { octokit, requests } = buildOctokit([{ status: 500 }]);

    await expect(
      octokit.request("POST /repos/owner/repo/issues/1/comments", {
        body: "hi",
        issue_number: 1,
        owner: "owner",
        repo: "repo",
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(1);
  });

  it("attaches an abort signal to every attempt", async () => {
    const { octokit, requests } = buildOctokit([{ status: 200 }]);

    await octokit.request("GET /rate_limit");

    expect(requests).toEqual([{ hasSignal: true, method: "GET" }]);
  });
});

describe("withRequestTimeout", () => {
  it("keeps a caller signal effective next to the deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    let seen: AbortSignal | undefined;
    const send = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response("{}"));
    };

    await withRequestTimeout(send)("https://api.github.com/rate_limit", {
      signal: controller.signal,
    });

    expect(seen?.aborted).toBe(true);
  });
});
