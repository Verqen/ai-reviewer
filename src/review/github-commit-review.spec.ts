import { describe, expect, it } from "vitest";

import { OPENROUTER_REVIEW_MODEL } from "~/config/models";
import { fingerprintFinding } from "~/domain/finding-fingerprint";
import { UnknownCatalogVersionError } from "~/domain/rule-catalog/rule-catalog";
import type { ArchiveEntry } from "~/domain/types/code-host.types";
import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
} from "~/domain/types/llm.types";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type {
  CheckRunCompletion,
  CreatedCheckRun,
} from "~/infrastructure/code-host/github/github.code-host";
import type {
  CommitReviewBaseline,
  CommitReviewCodeHost,
} from "~/review/github-commit-review";
import {
  countRepositoryReviewableFiles,
  resolveDefaultBranchHead,
  reviewRepositoryCommit,
} from "~/review/github-commit-review";
import { createMockLogger } from "~/test-utils/mock-logger";

const PINS = { [OPENROUTER_REVIEW_MODEL]: "anthropic" };

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

interface FakeCodeHost extends CommitReviewCodeHost {
  archiveRefs: string[];
  completions: CheckRunCompletion[];
  created: { detailsUrl?: string | undefined; headSha: string; name: string }[];
}

function fakeCodeHost(entries: readonly ArchiveEntry[]): FakeCodeHost {
  const host: FakeCodeHost = {
    archiveRefs: [],
    completions: [],
    created: [],
    createCheckRun(
      _projectId: number,
      params: {
        detailsUrl?: string | undefined;
        headSha: string;
        name: string;
      },
    ): Promise<CreatedCheckRun> {
      host.created.push(params);
      return Promise.resolve({
        id: 7,
        url: "https://github.com/owner/repo/runs/7",
      });
    },
    getFileContent(): Promise<string> {
      return Promise.resolve("");
    },
    getFileTree(): Promise<{ path: string; type: "blob" }[]> {
      return Promise.resolve([]);
    },
    getRepoId(): Promise<number> {
      return Promise.resolve(42);
    },
    getRepositoryArchive(
      _projectId: number,
      ref: string,
    ): Promise<ArchiveEntry[]> {
      host.archiveRefs.push(ref);
      return Promise.resolve([...entries]);
    },
    updateCheckRun(
      _projectId: number,
      _checkRunId: number,
      completion: CheckRunCompletion,
    ): Promise<void> {
      host.completions.push(completion);
      return Promise.resolve();
    },
  };
  return host;
}

interface FakeLlm extends ILlmClient {
  analysisPrompts: string[];
  extractionSystemPrompts: string[];
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
    usage: { completionTokens: 200, promptTokens: 2000 },
  };
}

function fakeLlm(
  findingFor: (filePath: string, call: number) => object[],
  crossFileFindings: readonly object[] = [],
): FakeLlm {
  const extractionCalls = new Map<string, number>();
  const llm: FakeLlm = {
    analysisPrompts: [],
    chatCompletion(
      messages: ChatMessage[],
      options?: LlmOptions,
    ): Promise<LlmResponse> {
      llm.options.push(options);
      const schema = JSON.stringify(options?.responseSchema ?? {});
      if (schema.includes("hunk_id")) {
        return Promise.resolve(response(JSON.stringify({ results: [] })));
      }
      if (schema.includes("original_snippet")) {
        llm.extractionSystemPrompts.push(textOf(messages[0]));
        const target = /Target file_path for every finding: (\S+)/.exec(
          textOf(messages[1]),
        );
        const filePath = target?.[1] ?? "";
        const call = (extractionCalls.get(filePath) ?? 0) + 1;
        extractionCalls.set(filePath, call);
        return Promise.resolve(
          response(JSON.stringify({ findings: findingFor(filePath, call) })),
        );
      }
      return Promise.resolve(
        response(JSON.stringify({ findings: crossFileFindings })),
      );
    },
    chatCompletionWithTools(
      messages: ChatMessage[],
      _tools: unknown,
      _executor: unknown,
      options?: LlmOptions,
    ): Promise<LlmResponse> {
      llm.options.push(options);
      llm.analysisPrompts.push(textOf(messages[1]));
      return Promise.resolve(response("## Analysis\nRisk on L1."));
    },
    extractionSystemPrompts: [],
    options: [],
  };
  return llm;
}

function finding(filePath: string, overrides: object = {}): object {
  return {
    confidence: 0.95,
    end_line: null,
    file_path: filePath,
    line_number: 1,
    line_type: "added",
    rule_id: "R-014",
    ...overrides,
  };
}

function source(path: string, lineCount = 3): ArchiveEntry {
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `export const v${String(index)} = ${String(index)};`,
  );
  return { content: Buffer.from(`${lines.join("\n")}\n`), path };
}

async function run(
  entries: readonly ArchiveEntry[],
  llm: FakeLlm,
  maxCostUsd = 100,
  maxReviewableFiles = 400,
  baseline?: CommitReviewBaseline,
): Promise<{
  host: FakeCodeHost;
  result: Awaited<ReturnType<typeof reviewRepositoryCommit>>;
}> {
  const host = fakeCodeHost(entries);
  const result = await reviewRepositoryCommit(
    {
      codeHost: host,
      llm,
      logger: createMockLogger(),
      models: {
        review: OPENROUTER_REVIEW_MODEL,
        triage: OPENROUTER_REVIEW_MODEL,
      },
      providerPins: PINS,
    },
    {
      catalogUrl: "https://verqen.dev/rules",
      commitSha: COMMIT_SHA,
      maxCostUsd,
      maxReviewableFiles,
      ...(baseline === undefined ? {} : { baseline }),
      owner: "owner",
      repo: "repo",
    },
  );
  return { host, result };
}

describe("reviewRepositoryCommit", () => {
  it("calls the model at temperature 0, without reasoning, on the pinned provider only", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    await run([source("src/a.ts")], llm);

    expect(llm.options.length).toBeGreaterThan(0);
    for (const options of llm.options) {
      expect(options).toMatchObject({
        provider: { allowFallbacks: false, order: ["anthropic"] },
        temperature: 0,
      });
      expect(options?.reasoning).toBeUndefined();
    }
  });

  it("refuses a model without a pinned provider before creating a check run", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);
    const host = fakeCodeHost([source("src/a.ts")]);

    await expect(
      reviewRepositoryCommit(
        {
          codeHost: host,
          llm,
          logger: createMockLogger(),
          models: {
            review: OPENROUTER_REVIEW_MODEL,
            triage: OPENROUTER_REVIEW_MODEL,
          },
          providerPins: {},
        },
        {
          commitSha: COMMIT_SHA,
          maxCostUsd: 100,
          maxReviewableFiles: 400,
          owner: "owner",
          repo: "repo",
        },
      ),
    ).rejects.toThrow(/pinned provider/);

    expect(host.created).toEqual([]);
    expect(llm.options).toEqual([]);
  });

  it("reviews the tree at the commit and publishes a neutral check run on it", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
    );

    expect(host.archiveRefs).toEqual([COMMIT_SHA]);
    expect(host.created).toEqual([
      {
        detailsUrl: "https://verqen.dev/rules",
        headSha: COMMIT_SHA,
        name: "Verqen",
      },
    ]);
    expect(host.completions).toHaveLength(1);
    expect(host.completions[0]?.conclusion).toBe("neutral");
    expect(host.completions[0]?.annotations).toEqual([
      {
        line: 1,
        message:
          "A value that can be absent is dereferenced here without a check.",
        path: "src/a.ts",
        rawDetails:
          "Condition: A value that can be null, undefined or empty is dereferenced without a check.\nRule: https://verqen.dev/rules#R-014",
        severity: "attention",
        title: "R-014 · Access to a possibly absent value without a guard",
      },
      {
        line: 1,
        message:
          "A value that can be absent is dereferenced here without a check.",
        path: "src/b.ts",
        rawDetails:
          "Condition: A value that can be null, undefined or empty is dereferenced without a check.\nRule: https://verqen.dev/rules#R-014",
        severity: "attention",
        title: "R-014 · Access to a possibly absent value without a guard",
      },
    ]);
    expect(result.catalogVersion).toBe("2026.10.1");
    expect(host.completions[0]?.summary).toContain("Rule catalog 2026.10.1");
    expect(result).toMatchObject({
      checkRunUrl: "https://github.com/owner/repo/runs/7",
      filesReviewed: 2,
      filesTotal: 2,
      partial: false,
    });
    expect(result.tokenCostUsd).toBeGreaterThan(0);
  });

  it("returns findings as rule, condition and location without any fix", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run([source("src/a.ts")], llm);

    expect(result.findings).toEqual([
      {
        condition:
          "A value that can be null, undefined or empty is dereferenced without a check.",
        filePath: "src/a.ts",
        fingerprint: fingerprintFinding(42, "R-014", "export const v0 = 0;"),
        line: 1,
        message:
          "A value that can be absent is dereferenced here without a check.",
        ruleId: "R-014",
        severity: "attention",
      },
    ]);
    for (const reported of result.findings) {
      expect(reported).not.toHaveProperty("suggestion");
    }
    const published = JSON.stringify(host.completions);
    expect(published).not.toContain("```suggestion");
    expect(published).not.toContain("const fixed = true;");
    expect(llm.extractionSystemPrompts[0]).toContain("rule_id MUST be one of");
  });

  it("says that no rule matched and how many files were checked when there are no findings", async () => {
    const llm = fakeLlm(() => []);

    const { host } = await run([source("src/a.ts"), source("src/b.ts")], llm);

    const summary = host.completions[0]?.summary ?? "";
    expect(summary).toContain(
      "No rule of the catalog matched. Checked 2 of 2 files.",
    );
    expect(summary).not.toContain("each one is attached");
  });

  it("publishes catalog text even when the model returns free text", async () => {
    const llm = fakeLlm((filePath) => [
      finding(filePath, {
        comment: "Wrong.\n\n```suggestion\nconst fixed = true;\n```",
        suggestion: "x",
      }),
    ]);

    const { host } = await run([source("src/a.ts")], llm);

    expect(JSON.stringify(host.completions)).not.toContain("```");
    expect(JSON.stringify(host.completions)).not.toContain("const fixed");
  });

  it("never sends skip-filtered files to the model", async () => {
    const llm = fakeLlm(() => []);

    const { result } = await run(
      [
        source("pnpm-lock.yaml"),
        source("dist/bundle.js"),
        source("src/kept.ts"),
      ],
      llm,
    );

    expect(result.filesTotal).toBe(1);
    expect(llm.analysisPrompts).toHaveLength(3);
    for (const prompt of llm.analysisPrompts) {
      expect(prompt).toContain("src/kept.ts");
    }
  });

  it("reviews a 1500-line file as three separate chunks", async () => {
    const llm = fakeLlm(() => []);

    const { result } = await run([source("src/big.ts", 1500)], llm);

    expect(llm.analysisPrompts).toHaveLength(9);
    expect(llm.analysisPrompts[0]).toContain("L1 + ");
    expect(llm.analysisPrompts[1]).toContain("L601 + ");
    expect(llm.analysisPrompts[2]).toContain("L1500 + ");
    expect(result.filesReviewed).toBe(1);
  });

  it("publishes only findings detected in at least two of three passes", async () => {
    const llm = fakeLlm((filePath, call) => {
      if (filePath === "src/a.ts") return call <= 2 ? [finding(filePath)] : [];
      return call === 3 ? [finding(filePath)] : [];
    });

    const { host, result } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
    );

    expect(result.findings.map((reported) => reported.filePath)).toEqual([
      "src/a.ts",
    ]);
    expect(host.completions[0]?.annotations).toHaveLength(1);
    expect(host.completions[0]?.summary).toContain(
      "Each finding was detected in at least 2 of 3 independent passes over the same code.",
    );
  });

  it("marks the run partial and counts only reviewed files when the budget runs out", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
      0.000001,
    );

    expect(result.partial).toBe(true);
    expect(result.filesTotal).toBe(2);
    expect(result.filesReviewed).toBe(0);
    expect(host.completions[0]?.summary).toContain("Partial result");
  });

  it("states the scope and asks to remove the GitHub App in the summary", async () => {
    const llm = fakeLlm(() => []);

    const { host } = await run(
      [source("src/a.ts"), source("src/b.ts"), source("package-lock.json")],
      llm,
    );

    const summary = host.completions[0]?.summary ?? "";
    expect(summary).toContain("Reviewed 2 of 2 files");
    expect(summary).toContain(COMMIT_SHA);
    expect(summary).toContain("uninstall the GitHub App");
    expect(summary).not.toContain("Partial result");
  });
});

describe("reviewRepositoryCommit comparison with an earlier run", () => {
  const baseline: CommitReviewBaseline = {
    catalogVersion: "2026.10.1",
    commitSha: "abcdef1234567890abcdef1234567890abcdef12",
    findings: [
      {
        filePath: "src/a.ts",
        fingerprint: fingerprintFinding(42, "R-014", "export const v0 = 0;"),
        line: 7,
        ruleId: "R-014",
      },
      {
        filePath: "src/gone.ts",
        fingerprint: "0123456789abcdef0123456789abcdef",
        line: 4,
        ruleId: "R-014",
      },
    ],
    finishedAt: "2026-09-29T10:15:00.000Z",
    runId: "11111111-1111-4111-8111-111111111111",
  };

  it("says a first run has nothing to compare with and returns no comparison", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run([source("src/a.ts")], llm);

    expect(result.comparison).toBeNull();
    expect(host.completions[0]?.summary).toContain(
      "First run for this repository: there is no earlier result to compare with.",
    );
  });

  it("publishes new, persisting and resolved findings against the baseline", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
      100,
      400,
      baseline,
    );

    expect(result.comparison).toEqual({
      baselineCatalogVersion: "2026.10.1",
      baselineCommitSha: baseline.commitSha,
      baselineFinishedAt: baseline.finishedAt,
      baselineRunId: baseline.runId,
      new: 1,
      notComparable: 0,
      persisting: 1,
      resolved: [
        {
          fileRemoved: true,
          filePath: "src/gone.ts",
          line: 4,
          ruleId: "R-014",
        },
      ],
    });
    const titles = host.completions[0]?.annotations.map(
      (annotation) => `${annotation.path} ${annotation.title}`,
    );
    expect(titles).toEqual([
      "src/a.ts R-014 · Access to a possibly absent value without a guard · persisting",
      "src/b.ts R-014 · Access to a possibly absent value without a guard · new",
    ]);
    const summary = host.completions[0]?.summary ?? "";
    expect(summary).toContain("Comparison with run abcdef1 (2026-09-29)");
    expect(summary).toContain("New: 1 · Persisting: 1 · Resolved: 1");
    expect(summary).toContain("R-014 · src/gone.ts:4 (file removed)");
    expect(summary).not.toContain("First run");
  });

  it("treats a file whose review failed in one pass as not fully reviewed", async () => {
    const llm = fakeLlm((filePath, call) => {
      if (filePath === "src/a.ts" && call === 2) {
        throw new Error("extraction failed");
      }
      return [finding(filePath)];
    });

    const { host, result } = await run(
      [
        source("src/a.ts"),
        source("src/b.ts"),
        { content: Buffer.from("{}"), path: "pnpm-lock.yaml" },
      ],
      llm,
      100,
      400,
      {
        ...baseline,
        findings: [
          {
            filePath: "src/a.ts",
            fingerprint: "0123456789abcdef0123456789abcdef",
            line: 2,
            ruleId: "R-014",
          },
          {
            filePath: "pnpm-lock.yaml",
            fingerprint: "fedcba9876543210fedcba9876543210",
            line: 1,
            ruleId: "R-014",
          },
        ],
      },
    );

    expect(result.partial).toBe(true);
    expect(result.filesTotal).toBe(2);
    expect(result.filesReviewed).toBe(1);
    expect(result.comparison).toMatchObject({
      new: 1,
      notComparable: 3,
      persisting: 0,
      resolved: [],
    });
    const summary = host.completions[0]?.summary ?? "";
    expect(summary).toContain("Partial result");
    expect(summary).toContain("Reviewed 1 of 2 files");
  });

  it("refuses a baseline of an unknown catalog version before creating a check run", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    await expect(
      run([source("src/a.ts")], llm, 100, 400, {
        ...baseline,
        catalogVersion: "1999.1.1",
      }),
    ).rejects.toThrow(UnknownCatalogVersionError);

    expect(llm.options).toEqual([]);
  });
});

describe("reviewRepositoryCommit check run lifecycle", () => {
  function deps(
    host: FakeCodeHost,
    llm: FakeLlm,
  ): Parameters<typeof reviewRepositoryCommit>[0] {
    return {
      codeHost: host,
      llm,
      logger: createMockLogger(),
      models: {
        review: OPENROUTER_REVIEW_MODEL,
        triage: OPENROUTER_REVIEW_MODEL,
      },
      providerPins: PINS,
    };
  }

  const options = {
    commitSha: COMMIT_SHA,
    maxCostUsd: 100,
    maxReviewableFiles: 400,
    owner: "owner",
    repo: "repo",
  };

  it("spends nothing when the check run cannot be created", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);
    const host = fakeCodeHost([source("src/a.ts")]);
    host.createCheckRun = (): Promise<CreatedCheckRun> =>
      Promise.reject(new Error("Resource not accessible by integration"));

    await expect(
      reviewRepositoryCommit(deps(host, llm), options),
    ).rejects.toThrow("Resource not accessible by integration");

    expect(llm.analysisPrompts).toEqual([]);
  });

  it("refuses before creating a check run when a model has no price", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);
    const host = fakeCodeHost([source("src/a.ts")]);

    await expect(
      reviewRepositoryCommit(
        {
          ...deps(host, llm),
          models: {
            review: "vendor/unpriced",
            triage: OPENROUTER_REVIEW_MODEL,
          },
        },
        options,
      ),
    ).rejects.toThrow(/no pricing/);

    expect(host.created).toEqual([]);
    expect(llm.analysisPrompts).toEqual([]);
  });

  it("creates no check run when the archive cannot be downloaded", async () => {
    const llm = fakeLlm(() => []);
    const host = fakeCodeHost([]);
    host.getRepositoryArchive = (): Promise<ArchiveEntry[]> =>
      Promise.reject(new Error("archive timeout"));

    await expect(
      reviewRepositoryCommit(deps(host, llm), options),
    ).rejects.toThrow("archive timeout");

    expect(host.created).toEqual([]);
    expect(host.completions).toEqual([]);
  });

  it("closes the check run as cancelled when the review fails", async () => {
    const llm = fakeLlm(() => []);
    const host = fakeCodeHost([source("src/a.ts")]);
    const failing: FakeLlm = {
      ...llm,
      chatCompletion: () => Promise.reject(new Error("model unavailable")),
      chatCompletionWithTools: () =>
        Promise.reject(new Error("model unavailable")),
    };

    await expect(
      reviewRepositoryCommit(deps(host, failing), options),
    ).rejects.toThrow();

    expect(host.completions).toHaveLength(1);
    expect(host.completions[0]).toMatchObject({
      annotations: [],
      conclusion: "cancelled",
    });
  });
});

describe("repository size limit", () => {
  it("refuses a repository over the file limit before creating a check run or calling the model", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);
    const calls = { completion: 0 };
    const counting: FakeLlm = {
      ...llm,
      chatCompletion(messages, options) {
        calls.completion++;
        return llm.chatCompletion(messages, options);
      },
      chatCompletionWithTools(messages, tools, toolExecutor, options) {
        calls.completion++;
        return llm.chatCompletionWithTools(
          messages,
          tools,
          toolExecutor,
          options,
        );
      },
    };
    const host = fakeCodeHost([
      source("src/a.ts"),
      source("src/b.ts"),
      source("src/c.ts"),
    ]);

    await expect(
      reviewRepositoryCommit(
        {
          codeHost: host,
          llm: counting,
          logger: createMockLogger(),
          models: {
            review: OPENROUTER_REVIEW_MODEL,
            triage: OPENROUTER_REVIEW_MODEL,
          },
          providerPins: PINS,
        },
        {
          commitSha: COMMIT_SHA,
          maxCostUsd: 100,
          maxReviewableFiles: 2,
          owner: "owner",
          repo: "repo",
        },
      ),
    ).rejects.toMatchObject({
      maxReviewableFiles: 2,
      name: "RepositoryTooLargeError",
      reviewableFiles: 3,
    });

    expect(host.created).toEqual([]);
    expect(calls.completion).toBe(0);
  });

  it.each([0, -1, Number.NaN, 1.5])(
    "refuses a file limit of %s before any network call",
    async (maxReviewableFiles) => {
      const llm = fakeLlm((filePath) => [finding(filePath)]);
      const host = fakeCodeHost([source("src/a.ts")]);
      let repoIdRequests = 0;
      const getRepoId = host.getRepoId.bind(host);
      host.getRepoId = (owner, repo) => {
        repoIdRequests++;
        return getRepoId(owner, repo);
      };

      await expect(
        reviewRepositoryCommit(
          {
            codeHost: host,
            llm,
            logger: createMockLogger(),
            models: {
              review: OPENROUTER_REVIEW_MODEL,
              triage: OPENROUTER_REVIEW_MODEL,
            },
            providerPins: PINS,
          },
          {
            commitSha: COMMIT_SHA,
            maxCostUsd: 100,
            maxReviewableFiles,
            owner: "owner",
            repo: "repo",
          },
        ),
      ).rejects.toThrow(
        `maxReviewableFiles must be a positive integer, got ${String(maxReviewableFiles)}`,
      );

      expect(repoIdRequests).toBe(0);
      expect(host.created).toEqual([]);
      expect(llm.analysisPrompts).toEqual([]);
    },
  );

  it("counts only reviewable files", async () => {
    const host = fakeCodeHost([
      source("src/a.ts"),
      { content: Buffer.from("{}"), path: "pnpm-lock.yaml" },
      { content: Buffer.from([0, 1, 2]), path: "logo.png" },
    ]);
    await expect(
      countRepositoryReviewableFiles(host, {
        commitSha: COMMIT_SHA,
        owner: "owner",
        repo: "repo",
      }),
    ).resolves.toEqual({ reviewableFiles: 1 });
  });

  it("reviews a repository exactly at the limit", async () => {
    const llm = fakeLlm(() => []);
    const { host } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
      100,
      2,
    );
    expect(host.created).toHaveLength(1);
  });
});

describe("resolveDefaultBranchHead", () => {
  it("returns the head commit of the repository's default branch", async () => {
    const lookups: string[] = [];
    const head = await resolveDefaultBranchHead(
      {
        getBranchHeadSha(projectId: number, branch: string): Promise<string> {
          lookups.push(`${String(projectId)}:${branch}`);
          return Promise.resolve(COMMIT_SHA);
        },
        getDefaultBranch(): Promise<string> {
          return Promise.resolve("trunk");
        },
        getRepoId(): Promise<number> {
          return Promise.resolve(42);
        },
      },
      { owner: "owner", repo: "repo" },
    );

    expect(head).toEqual({
      defaultBranch: "trunk",
      headSha: COMMIT_SHA,
      repoId: 42,
    });
    expect(lookups).toEqual(["42:trunk"]);
  });
});
