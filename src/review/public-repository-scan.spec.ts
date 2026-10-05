import { describe, expect, it } from "vitest";

import { ORDER_RUN_MODEL } from "~/config/models";
import { RULE_CATALOG_VERSION } from "~/domain/rule-catalog/rule-catalog";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { ArchiveEntry } from "~/domain/types/code-host.types";
import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
} from "~/domain/types/llm.types";
import { extractTarGzArchive } from "~/infrastructure/archive/tar-gz-archive";
import type { PublicScanReport } from "~/review/public-repository-scan";
import {
  exitCodeFor,
  scanRepositoryArchive,
} from "~/review/public-repository-scan";
import { createMockLogger } from "~/test-utils/mock-logger";
import { buildTarGzFixture } from "~/test-utils/tar-gz-fixture";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const PINS = { [ORDER_RUN_MODEL]: "pinned-provider" };
const SECRET_VALUE = ["fixture", "credential", "value", "0000"].join("-");
const SECRET_LINE = `export const apiKey = "${SECRET_VALUE}";`;

interface FakeLlm extends ILlmClient {
  calls: number;
  options: (LlmOptions | undefined)[];
}

function textOf(message: ChatMessage | undefined): string {
  if (message === undefined || message.content === null) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => block.text).join("\n");
}

function response(content: string): LlmResponse {
  return {
    content,
    toolCalls: [],
    usage: { completionTokens: 100, promptTokens: 1000 },
  };
}

function credentialFinding(filePath: string): object {
  return {
    confidence: 0.95,
    end_line: null,
    file_path: filePath,
    line_number: 1,
    line_type: "added",
    original_snippet: SECRET_LINE,
    rule_id: "R-001",
  };
}

function fakeLlm(flaggedPath: string | null, failing = false): FakeLlm {
  const llm: FakeLlm = {
    calls: 0,
    chatCompletion(
      messages: ChatMessage[],
      options?: LlmOptions,
    ): Promise<LlmResponse> {
      llm.calls++;
      llm.options.push(options);
      if (failing) return Promise.reject(new Error("provider unavailable"));
      const schema = JSON.stringify(options?.responseSchema ?? {});
      if (schema.includes("hunk_id")) {
        return Promise.resolve(response(JSON.stringify({ results: [] })));
      }
      if (schema.includes("original_snippet")) {
        const target = /Target file_path for every finding: (\S+)/.exec(
          textOf(messages[1]),
        );
        const findings =
          target?.[1] === flaggedPath ? [credentialFinding(flaggedPath)] : [];
        return Promise.resolve(response(JSON.stringify({ findings })));
      }
      return Promise.resolve(response(JSON.stringify({ findings: [] })));
    },
    chatCompletionWithTools(
      _messages: ChatMessage[],
      _tools: unknown,
      _executor: unknown,
      options?: LlmOptions,
    ): Promise<LlmResponse> {
      llm.calls++;
      llm.options.push(options);
      if (failing) return Promise.reject(new Error("provider unavailable"));
      return Promise.resolve(response("## Analysis\nRisk on L1."));
    },
    options: [],
  };
  return llm;
}

function source(path: string, lineCount = 3): ArchiveEntry {
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `export const v${String(index)} = ${String(index)};`,
  );
  return { content: Buffer.from(`${lines.join("\n")}\n`), path };
}

async function fixtureArchive(): Promise<ArchiveEntry[]> {
  return extractTarGzArchive(
    await buildTarGzFixture([
      { name: "owner-repo-0123456/", type: "directory" },
      { content: `${SECRET_LINE}\n`, name: "owner-repo-0123456/src/keys.ts" },
      {
        content: "export const answer = 42;\n",
        name: "owner-repo-0123456/src/answer.ts",
      },
      {
        content: "lockfileVersion: 9\n",
        name: "owner-repo-0123456/pnpm-lock.yaml",
      },
      { content: "", name: "owner-repo-0123456/src/empty.ts" },
    ]),
  );
}

function steppingClock(stepMs: number): () => Date {
  let now = Date.UTC(2026, 0, 1);
  return () => {
    const current = new Date(now);
    now += stepMs;
    return current;
  };
}

async function scan(
  archive: readonly ArchiveEntry[],
  llm: FakeLlm,
  options: { logged?: unknown[]; maxReviewableFiles?: number } = {},
): Promise<PublicScanReport> {
  const record = (...args: unknown[]): void => {
    options.logged?.push(args);
  };
  return scanRepositoryArchive(
    {
      llm,
      logger: createMockLogger({
        debug: record,
        error: record,
        fatal: record,
        info: record,
        trace: record,
        warn: record,
      }),
      models: { review: ORDER_RUN_MODEL, triage: ORDER_RUN_MODEL },
      providerPins: PINS,
    },
    {
      archive,
      clock: steppingClock(250),
      commitSha: COMMIT_SHA,
      maxCostUsd: 0.5,
      maxReviewableFiles: options.maxReviewableFiles ?? 400,
      repository: "owner/repo",
    },
  );
}

describe("scanRepositoryArchive", () => {
  it("counts the reviewable files of an archive and names why the rest were skipped", async () => {
    const report = await scan(await fixtureArchive(), fakeLlm(null));

    expect(report.files_counted).toBe(2);
    expect(report.files_reviewed).toBe(2);
    expect(report.files_skipped).toEqual([
      { path: "pnpm-lock.yaml", reason: "lock" },
      { path: "src/empty.ts", reason: "empty" },
    ]);
  });

  it("writes a report of catalog data only, with rule id, file and line per finding", async () => {
    const llm = fakeLlm("src/keys.ts");

    const report = await scan(await fixtureArchive(), llm);

    expect(Object.keys(report).sort()).toEqual(
      [
        "catalog_version",
        "commit_sha",
        "consensus",
        "cost_usd",
        "duration_ms",
        "error",
        "files_counted",
        "files_not_fully_reviewed",
        "files_reviewed",
        "files_skipped",
        "findings",
        "max_cost_usd",
        "max_reviewable_files",
        "models",
        "passes",
        "repository",
        "started_at",
        "status",
      ].sort(),
    );
    expect(report).toMatchObject({
      catalog_version: RULE_CATALOG_VERSION,
      commit_sha: COMMIT_SHA,
      consensus: { passes: 3, quorum: 2 },
      duration_ms: 250,
      error: null,
      max_cost_usd: 0.5,
      max_reviewable_files: 400,
      models: { review: ORDER_RUN_MODEL, triage: ORDER_RUN_MODEL },
      repository: "owner/repo",
      started_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
    });
    expect(report.findings).toEqual([
      { file: "src/keys.ts", line: 1, rule_id: "R-001" },
    ]);
    expect(report.passes.map((pass) => pass.findings)).toEqual([1, 1, 1]);
    expect(report.cost_usd).toBeGreaterThan(0);
    expect(report.cost_usd).toBeCloseTo(
      report.passes.reduce((total, pass) => total + pass.cost_usd, 0),
    );
    expect(exitCodeFor(report.status)).toBe(0);
  });

  it("calls the model at temperature 0 on the pinned provider only", async () => {
    const llm = fakeLlm(null);

    await scan([source("src/a.ts")], llm);

    expect(llm.options.length).toBeGreaterThan(0);
    for (const options of llm.options) {
      expect(options).toMatchObject({
        model: ORDER_RUN_MODEL,
        provider: { allowFallbacks: false, order: ["pinned-provider"] },
        temperature: 0,
      });
    }
  });

  it("never writes the value of a credential literal, in the report or the logs", async () => {
    const logged: unknown[] = [];

    const report = await scan(await fixtureArchive(), fakeLlm("src/keys.ts"), {
      logged,
    });

    expect(report.findings).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(logged)).not.toContain(SECRET_VALUE);
  });

  it("refuses a repository over the file limit without calling the model", async () => {
    const llm = fakeLlm(null);
    const archive = [
      source("src/a.ts"),
      source("src/b.ts"),
      source("src/c.ts"),
    ];

    const report = await scan(archive, llm, { maxReviewableFiles: 2 });

    expect(llm.calls).toBe(0);
    expect(report).toMatchObject({
      cost_usd: 0,
      error: "Repository has 3 reviewable files; the limit is 2",
      files_counted: 3,
      findings: [],
      passes: [],
      status: "repository_too_large",
    });
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it("reports a run the provider could not serve as failed, with no findings", async () => {
    const report = await scan([source("src/a.ts")], fakeLlm(null, true));

    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({
      cost_usd: null,
      error: "All file reviews failed",
      files_counted: 1,
      files_reviewed: 0,
      status: "failed",
    });
    expect(exitCodeFor(report.status)).toBe(1);
  });
});
