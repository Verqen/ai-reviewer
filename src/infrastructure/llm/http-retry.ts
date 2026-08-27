const MAX_RETRY_DELAY_MS = 20_000;
const MAX_UPSTREAM_BODY_CHARS = 500;
const MAX_CAUSE_DEPTH = 4;

const TRANSIENT_ERROR_NAMES = new Set([
  "AbortError",
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "SocketError",
  "TimeoutError",
]);

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface ErrorMarkers {
  cause: unknown;
  code: string | undefined;
  name: string | undefined;
}

const NO_MARKERS: ErrorMarkers = {
  cause: undefined,
  code: undefined,
  name: undefined,
};

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" ? String(value) : undefined;
}

function readErrorMarkers(value: unknown): ErrorMarkers {
  if (typeof value !== "object" || value === null) {
    return NO_MARKERS;
  }
  return {
    cause: "cause" in value ? value.cause : undefined,
    code: "code" in value ? asText(value.code) : undefined,
    name: "name" in value ? asText(value.name) : undefined,
  };
}

function isTransientTransportError(
  error: unknown,
  depth: number = MAX_CAUSE_DEPTH,
): boolean {
  const { cause, code, name } = readErrorMarkers(error);

  if (name !== undefined && TRANSIENT_ERROR_NAMES.has(name)) {
    return true;
  }
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }
  if (typeof cause !== "object" || cause === null || depth <= 0) {
    return false;
  }
  if (isTransientTransportError(cause, depth - 1)) {
    return true;
  }
  return name === "TypeError";
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const retryAfter = headers?.get("retry-after") ?? null;
  if (retryAfter === null) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

function describeUpstreamFailure(
  provider: string,
  status: number,
  body: string,
): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return `${provider} API error: ${status}`;
  }
  const detail =
    trimmed.length > MAX_UPSTREAM_BODY_CHARS
      ? `${trimmed.slice(0, MAX_UPSTREAM_BODY_CHARS)}...`
      : trimmed;
  return `${provider} API error: ${status} ${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  describeUpstreamFailure,
  isTransientTransportError,
  MAX_RETRY_DELAY_MS,
  retryAfterMs,
  sleep,
};
