import type { Octokit } from "@octokit/rest";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 20000;

interface HttpLikeError {
  response?: { headers?: Record<string, string | undefined> };
  status?: number;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 403 || status === 429 || (status !== undefined && status >= 500);
}

function retryAfterMs(error: HttpLikeError, attempt: number): number {
  const headers = error.response?.headers ?? {};
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const reset = headers["x-ratelimit-reset"];
  if (reset !== undefined) {
    const resetMs = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs, MAX_DELAY_MS);
    }
  }
  const backoff = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return Math.min(backoff + jitter, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installGitHubResilience(octokit: Octokit): Octokit {
  octokit.hook.wrap("request", async (request, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(options);
      } catch (error) {
        const status = (error as HttpLikeError).status;
        if (!isRetryableStatus(status) || attempt >= MAX_RETRIES) {
          throw error;
        }
        await sleep(retryAfterMs(error as HttpLikeError, attempt));
      }
    }
  });
  return octokit;
}

export { installGitHubResilience, isRetryableStatus, retryAfterMs };
