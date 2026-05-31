import type { IConfig } from "~/shared/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context7ConfigSchema } from "~/config/context7.config";
import { createMockLogger } from "~/test-utils/mock-logger";

import { Context7Provider } from "./context7.provider";

function buildConfig(
  overrides: Partial<Context7ConfigSchema> = {}
): IConfig<Context7ConfigSchema> {
  return {
    envs: {
      CONTEXT7_API_KEY: undefined,
      CONTEXT7_BASE_URL: "https://context7.com",
      CONTEXT7_ENABLED: true,
      CONTEXT7_MAX_TOKENS: 10000,
      ...overrides,
    },
  };
}

describe("Context7Provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveLibrary", () => {
    it("returns LibraryInfo for the highest relevance result", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        json: () => ({
          results: [
            {
              description: "Fast web framework",
              id: "/fastify/fastify",
              name: "fastify",
              relevanceScore: 0.9,
              snippetCount: 120,
            },
            {
              description: "Another web framework",
              id: "/some/other",
              name: "other",
              relevanceScore: 0.5,
              snippetCount: 10,
            },
          ],
        }),
        ok: true,
        status: 200,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const result = await provider.resolveLibrary("fastify", "routing");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("/fastify/fastify");
      expect(result?.name).toBe("fastify");
      expect(result?.snippetCount).toBe(120);
    });

    it("returns null when results array is empty", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        json: () => ({ results: [] }),
        ok: true,
        status: 200,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const result = await provider.resolveLibrary("unknown-pkg");

      expect(result).toBeNull();
    });

    it("returns null on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const result = await provider.resolveLibrary("nonexistent");

      expect(result).toBeNull();
    });

    it("retries once on 429 and returns result", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          headers: { get: () => "0" },
          ok: false,
          status: 429,
        })
        .mockResolvedValueOnce({
          json: () => ({
            results: [
              {
                description: "Schema validation",
                id: "/colinhacks/zod",
                name: "zod",
                relevanceScore: 0.95,
                snippetCount: 200,
              },
            ],
          }),
          ok: true,
          status: 200,
        });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const result = await provider.resolveLibrary("zod");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result?.id).toBe("/colinhacks/zod");
    });

    it("returns null gracefully on network error", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network failure"));
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const result = await provider.resolveLibrary("zod");

      expect(result).toBeNull();
    });

    it("caches resolved library ID on second call", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        json: () => ({
          results: [
            {
              description: "Schema validation",
              id: "/colinhacks/zod",
              name: "zod",
              relevanceScore: 0.95,
              snippetCount: 200,
            },
          ],
        }),
        ok: true,
        status: 200,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      await provider.resolveLibrary("zod");
      await provider.resolveLibrary("zod");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("queryDocs", () => {
    it("returns text content from API", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => "Zod is a TypeScript-first schema validation library.",
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const docs = await provider.queryDocs("/colinhacks/zod", "z.coerce");

      expect(docs).toBe("Zod is a TypeScript-first schema validation library.");
    });

    it("returns empty string on 404", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const docs = await provider.queryDocs("/missing/lib", "topic");

      expect(docs).toBe("");
    });

    it("retries once on 429 and returns content", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          headers: { get: () => "0" },
          ok: false,
          status: 429,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => "Documentation content here",
        });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const docs = await provider.queryDocs("/colinhacks/zod", "coerce");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(docs).toBe("Documentation content here");
    });

    it("returns empty string gracefully on network error", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(buildConfig(), createMockLogger());
      const docs = await provider.queryDocs("/colinhacks/zod", "coerce");

      expect(docs).toBe("");
    });

    it("includes Authorization header when API key configured", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => "docs",
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new Context7Provider(
        buildConfig({ CONTEXT7_API_KEY: "test-key-123" }),
        createMockLogger()
      );
      await provider.queryDocs("/colinhacks/zod", "coerce");

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer test-key-123"
      );
    });
  });
});
