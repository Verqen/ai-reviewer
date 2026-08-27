const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableResponse(method: string, status: number): boolean {
  if (status === 429) {
    return true;
  }
  return IDEMPOTENT_METHODS.has(method) && isRetryableStatus(status);
}

function backoffMs(attempt: number): number {
  const backoff = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return Math.min(backoff + jitter, MAX_DELAY_MS);
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  return backoffMs(attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithResilience(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (!IDEMPOTENT_METHODS.has(method) || attempt >= MAX_RETRIES) {
        throw err;
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (
      !isRetryableResponse(method, response.status) ||
      attempt >= MAX_RETRIES
    ) {
      return response;
    }

    await sleep(retryDelayMs(response, attempt));
  }
}

export {
  fetchWithResilience,
  isRetryableResponse,
  isRetryableStatus,
  REQUEST_TIMEOUT_MS,
};
