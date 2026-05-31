import type { FastifyBaseLogger } from "fastify";
import PQueue from "p-queue";

import type {
  IDocProvider,
  LibraryInfo,
} from "~/domain/ports/doc-provider.port";
import type { ParsedFileDiff } from "~/review/diff-parser";

const IMPORT_REGEX = /(?:from|require\()\s*['"]([^'"]+)['"]/g;

function getWorkspacePrefixes(): string[] {
  const raw = process.env["WORKSPACE_PACKAGE_PREFIXES"] ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractExternalPackages(content: string): string[] {
  const packages = new Set<string>();
  const workspacePrefixes = getWorkspacePrefixes();

  for (const match of content.matchAll(IMPORT_REGEX)) {
    const raw = match[1];
    if (!raw) continue;
    if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("~/"))
      continue;
    if (workspacePrefixes.some((prefix) => raw.startsWith(prefix))) continue;

    const normalized = raw.startsWith("@")
      ? raw.split("/").slice(0, 2).join("/")
      : (raw.split("/")[0] ?? raw);
    if (normalized) {
      packages.add(normalized);
    }
  }

  return [...packages];
}

const MAX_LIBRARIES_PER_REVIEW = 10;
const MAX_LIBRARIES_PER_FILE = 2;
const RESOLVE_CONCURRENCY = 5;

interface ResolvedLibraries {
  byName: Map<string, LibraryInfo>;
  docQueryCache?: Map<string, string> | undefined;
}

async function resolveLibrariesFromDiffs(
  diffs: ParsedFileDiff[],
  docProvider: IDocProvider,
  logger: FastifyBaseLogger,
  maxLibraries = MAX_LIBRARIES_PER_REVIEW
): Promise<ResolvedLibraries> {
  const allContent = diffs
    .map((d) => d.lines.map((l) => l.content).join("\n"))
    .join("\n");

  const packages = extractExternalPackages(allContent).slice(0, maxLibraries);

  const byName = new Map<string, LibraryInfo>();
  const queue = new PQueue({ concurrency: RESOLVE_CONCURRENCY });

  const tasks = packages.map((pkg) =>
    queue.add(async () => {
      try {
        const info = await docProvider.resolveLibrary(pkg, "API usage");
        if (info) {
          byName.set(pkg, info);
        }
      } catch (err) {
        logger.warn({ err, pkg }, "Failed to resolve library, skipping");
      }
    })
  );

  await Promise.all(tasks);

  return { byName, docQueryCache: new Map() };
}

async function fetchDocContextForFile(
  diffContent: string,
  resolvedLibraries: ResolvedLibraries,
  docProvider: IDocProvider,
  logger: FastifyBaseLogger,
  maxTokensPerQuery: number
): Promise<string> {
  const packages = extractExternalPackages(diffContent).slice(
    0,
    MAX_LIBRARIES_PER_FILE
  );
  const sections: string[] = [];

  for (const pkg of packages) {
    const info = resolvedLibraries.byName.get(pkg);
    if (!info) continue;

    try {
      const cacheKey = `${info.id}:${pkg}:${maxTokensPerQuery}`;
      const cached = resolvedLibraries.docQueryCache?.get(cacheKey);
      const docs =
        cached ??
        (await docProvider.queryDocs(info.id, pkg, maxTokensPerQuery));
      if (docs) {
        resolvedLibraries.docQueryCache ??= new Map<string, string>();
        resolvedLibraries.docQueryCache.set(cacheKey, docs);
        sections.push(`[${pkg}] ${docs}`);
      }
    } catch (err) {
      logger.warn({ err, pkg }, "Failed to fetch docs for package, skipping");
    }
  }

  if (sections.length === 0) {
    return "";
  }

  return `--- Library Documentation ---\n${sections.join("\n\n")}`;
}

export { fetchDocContextForFile, resolveLibrariesFromDiffs };
export type { ResolvedLibraries };
