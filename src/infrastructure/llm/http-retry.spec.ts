import { describe, expect, it } from "vitest";

import {
  describeUpstreamFailure,
  isTransientTransportError,
  retryAfterMs,
} from "~/infrastructure/llm/http-retry";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isTransientTransportError", () => {
  it("classifies an undici fetch failure by its cause code", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]) {
      const error = new TypeError("fetch failed", {
        cause: withCode(`socket ${code}`, code),
      });
      expect(isTransientTransportError(error)).toBe(true);
    }
  });

  it("classifies a terminated stream by its undici cause", () => {
    const cause = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
      name: "SocketError",
    });
    expect(
      isTransientTransportError(new TypeError("terminated", { cause })),
    ).toBe(true);
  });

  it("classifies an aborted request", () => {
    expect(
      isTransientTransportError(new DOMException("aborted", "AbortError")),
    ).toBe(true);
  });

  it("classifies a signal timeout", () => {
    expect(
      isTransientTransportError(new DOMException("timed out", "TimeoutError")),
    ).toBe(true);
  });

  it("classifies a nested cause chain", () => {
    const inner = withCode("connect ETIMEDOUT", "ETIMEDOUT");
    const middle = new Error("connection failure", { cause: inner });
    expect(
      isTransientTransportError(
        new TypeError("fetch failed", { cause: middle }),
      ),
    ).toBe(true);
  });

  it("does not classify an upstream status error as transient", () => {
    expect(
      isTransientTransportError(new Error("OpenRouter API error: 400 bad")),
    ).toBe(false);
  });

  it("does not classify a programming TypeError as transient", () => {
    expect(
      isTransientTransportError(new TypeError("value is not a function")),
    ).toBe(false);
  });

  it("does not classify non-error values as transient", () => {
    expect(isTransientTransportError(null)).toBe(false);
    expect(isTransientTransportError("ECONNRESET")).toBe(false);
    expect(isTransientTransportError(undefined)).toBe(false);
  });

  it("stops walking an endless cause chain", () => {
    const looping: { cause?: unknown; name: string } = { name: "Error" };
    looping.cause = looping;
    expect(isTransientTransportError(looping)).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads retry-after seconds", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000);
  });

  it("caps an oversized retry-after", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "9999" }))).toBe(20_000);
  });

  it("ignores a missing or unusable retry-after", () => {
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "0" }))).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe("describeUpstreamFailure", () => {
  it("keeps the status and the upstream body", () => {
    expect(describeUpstreamFailure("OpenRouter", 429, "slow down")).toBe(
      "OpenRouter API error: 429 slow down",
    );
  });

  it("omits an empty body", () => {
    expect(describeUpstreamFailure("Ollama", 500, "  ")).toBe(
      "Ollama API error: 500",
    );
  });

  it("truncates a long body", () => {
    const message = describeUpstreamFailure("Ollama", 500, "x".repeat(2000));
    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("...")).toBe(true);
  });
});
