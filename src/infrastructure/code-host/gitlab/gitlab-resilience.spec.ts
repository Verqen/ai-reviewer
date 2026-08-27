import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchWithResilience } from "./gitlab-resilience";

function jsonResponse(status: number, headers: Record<string, string> = {}) {
  return new Response("{}", { headers, status });
}

describe("fetchWithResilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function runWithTimers<T>(work: Promise<T>): Promise<T> {
    const settled = work;
    await vi.runAllTimersAsync();
    return settled;
  }

  it("attaches an abort signal to every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await runWithTimers(fetchWithResilience("https://gitlab.test/api"));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a GET on 500 and returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runWithTimers(
      fetchWithResilience("https://gitlab.test/api"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a GET when fetch itself rejects", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runWithTimers(
      fetchWithResilience("https://gitlab.test/api"),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a POST on 500, so a comment is never posted twice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runWithTimers(
      fetchWithResilience("https://gitlab.test/api", { method: "POST" }),
    );

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a POST on 429, which means the request was not processed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse(201));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runWithTimers(
      fetchWithResilience("https://gitlab.test/api", { method: "POST" }),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and returns the last response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal("fetch", fetchMock);

    const response = await runWithTimers(
      fetchWithResilience("https://gitlab.test/api"),
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
