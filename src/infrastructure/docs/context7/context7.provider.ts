import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";

import type { Context7ConfigSchema } from "~/config/context7.config";
import type {
  IDocProvider,
  LibraryInfo,
} from "~/domain/ports/doc-provider.port";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";

const RETRY_AFTER_DEFAULT_MS = 1000;
const LIBRARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

interface Context7LibraryResult {
  description: string;
  id: string;
  name: string;
  relevanceScore?: number;
  snippetCount?: number;
  trust?: number;
}

interface Context7SearchResponse {
  results?: Context7LibraryResult[];
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

class Context7Provider implements IDocProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly libraryCache = new MemoryCache<LibraryInfo>(
    MAX_CACHE_SIZE,
    LIBRARY_CACHE_TTL_MS
  );

  constructor(
    config: IConfig<Context7ConfigSchema>,
    private readonly logger: FastifyBaseLogger
  ) {
    this.apiKey = config.envs.CONTEXT7_API_KEY;
    this.baseUrl = config.envs.CONTEXT7_BASE_URL;
    this.maxTokens = config.envs.CONTEXT7_MAX_TOKENS;
  }

  async resolveLibrary(
    name: string,
    query?: string
  ): Promise<LibraryInfo | null> {
    const cacheKey = `lib:${name}:${query ?? ""}`;
    const cached = this.libraryCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const url = new URL(`${this.baseUrl}/api/v2/libs/search`);
    url.searchParams.set("libraryName", name);
    if (query) {
      url.searchParams.set("query", query);
    }

    const result = await this.fetchWithRetry<Context7SearchResponse>(
      url.toString()
    );
    if (result === null) {
      return null;
    }

    const results = result.results ?? [];
    if (results.length === 0) {
      return null;
    }

    const sorted = [...results].sort(
      (a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
    );
    const best = sorted[0];
    if (!best) {
      return null;
    }

    const info: LibraryInfo = {
      description: best.description,
      id: best.id,
      name: best.name,
      snippetCount: best.snippetCount ?? 0,
    };

    this.libraryCache.set(cacheKey, info);
    return info;
  }

  async queryDocs(
    libraryId: string,
    topic: string,
    maxTokens?: number
  ): Promise<string> {
    const tokens = maxTokens ?? this.maxTokens;
    const url = new URL(`${this.baseUrl}/api/v2/context`);
    url.searchParams.set("libraryId", libraryId);
    url.searchParams.set("query", topic);
    url.searchParams.set("type", "txt");
    url.searchParams.set("tokens", String(tokens));

    const result = await this.fetchWithRetry<string>(url.toString(), true);
    if (result === null) {
      return "";
    }
    return typeof result === "string" ? result : "";
  }

  private async fetchWithRetry<T>(
    url: string,
    asText = false
  ): Promise<T | null> {
    const headers = buildHeaders(this.apiKey);

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (err) {
      this.logger.warn({ err, url }, "Context7 network error, skipping docs");
      return null;
    }

    if (response.status === 404) {
      return null;
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const delayMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : RETRY_AFTER_DEFAULT_MS;

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

      let retryResponse: Response;
      try {
        retryResponse = await fetch(url, { headers });
      } catch (err) {
        this.logger.warn(
          { err, url },
          "Context7 network error on retry, skipping docs"
        );
        return null;
      }

      if (!retryResponse.ok) {
        this.logger.warn(
          { status: retryResponse.status, url },
          "Context7 retry failed, skipping docs"
        );
        return null;
      }

      return asText
        ? ((await retryResponse.text()) as T)
        : ((await retryResponse.json()) as T);
    }

    if (!response.ok) {
      this.logger.warn(
        { status: response.status, url },
        "Context7 request failed, skipping docs"
      );
      return null;
    }

    return asText
      ? ((await response.text()) as T)
      : ((await response.json()) as T);
  }
}

export { Context7Provider };
