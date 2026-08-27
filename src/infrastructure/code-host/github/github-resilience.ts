import type { Octokit } from "@octokit/rest";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ARCHIVE_REQUEST_TIMEOUT_MS = 300_000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface RateLimitHeaders {
  remaining: string | undefined;
  reset: string | undefined;
  retryAfter: string | undefined;
}

const NO_RATE_LIMIT_HEADERS: RateLimitHeaders = {
  remaining: undefined,
  reset: undefined,
  retryAfter: undefined,
};

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" ? String(value) : undefined;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const { status } = error;
  return typeof status === "number" ? status : undefined;
}

function readRateLimitHeaders(error: unknown): RateLimitHeaders {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return NO_RATE_LIMIT_HEADERS;
  }
  const { response } = error;
  if (
    typeof response !== "object" ||
    response === null ||
    !("headers" in response)
  ) {
    return NO_RATE_LIMIT_HEADERS;
  }
  const { headers } = response;
  if (typeof headers !== "object" || headers === null) {
    return NO_RATE_LIMIT_HEADERS;
  }
  return {
    remaining:
      "x-ratelimit-remaining" in headers
        ? asText(headers["x-ratelimit-remaining"])
        : undefined,
    reset:
      "x-ratelimit-reset" in headers
        ? asText(headers["x-ratelimit-reset"])
        : undefined,
    retryAfter:
      "retry-after" in headers ? asText(headers["retry-after"]) : undefined,
  };
}

function isRateLimited(headers: RateLimitHeaders): boolean {
  if (headers.retryAfter !== undefined) {
    return true;
  }
  if (headers.remaining === undefined) {
    return false;
  }
  const remaining = Number(headers.remaining);
  return Number.isFinite(remaining) && remaining <= 0;
}

function isRetryableError(method: string, error: unknown): boolean {
  const status = readStatus(error);
  if (status === undefined) {
    return false;
  }
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    return isRateLimited(readRateLimitHeaders(error));
  }
  return status >= 500 && IDEMPOTENT_METHODS.has(method);
}

function backoffMs(attempt: number): number {
  const backoff = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return Math.min(backoff + jitter, MAX_DELAY_MS);
}

function retryAfterMs(error: unknown, attempt: number): number {
  const { retryAfter, reset } = readRateLimitHeaders(error);
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  if (reset !== undefined) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs, MAX_DELAY_MS);
    }
  }
  return backoffMs(attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function withRequestTimeout(
  fetchImpl?: FetchLike,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): FetchLike {
  return (input, init) => {
    const send = fetchImpl ?? globalThis.fetch;
    const deadline = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal;
    const signal =
      caller == null ? deadline : AbortSignal.any([caller, deadline]);
    return send(input, { ...init, signal });
  };
}

function installGitHubResilience(octokit: Octokit): Octokit {
  octokit.hook.wrap("request", async (request, options) => {
    const method = options.method.toUpperCase();

    for (let attempt = 0; ; attempt++) {
      try {
        return await request(options);
      } catch (error) {
        if (!isRetryableError(method, error) || attempt >= MAX_RETRIES) {
          throw error;
        }
        await sleep(retryAfterMs(error, attempt));
      }
    }
  });
  return octokit;
}

export {
  ARCHIVE_REQUEST_TIMEOUT_MS,
  installGitHubResilience,
  isRetryableError,
  REQUEST_TIMEOUT_MS,
  retryAfterMs,
  withRequestTimeout,
};
