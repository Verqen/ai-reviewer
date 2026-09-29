import { describe, expect, it } from "vitest";

import { OPENROUTER_REVIEW_MODEL } from "~/config/models";
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
import type { CommitReviewCodeHost } from "~/review/github-commit-review";
import {
  resolveDefaultBranchHead,
  reviewRepositoryCommit,
} from "~/review/github-commit-review";
import { createMockLogger } from "~/test-utils/mock-logger";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

interface FakeCodeHost extends CommitReviewCodeHost {
  archiveRefs: string[];
  completions: CheckRunCompletion[];
  created: { headSha: string; name: string }[];
}

function fakeCodeHost(entries: readonly ArchiveEntry[]): FakeCodeHost {
  const host: FakeCodeHost = {
    archiveRefs: [],
    completions: [],
    created: [],
    createCheckRun(
      _projectId: number,
      params: { headSha: string; name: string },
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
  findingFor: (filePath: string) => object[],
  crossFileFindings: readonly object[] = [],
): FakeLlm {
  const llm: FakeLlm = {
    analysisPrompts: [],
    chatCompletion(
      messages: ChatMessage[],
      options?: LlmOptions,
    ): Promise<LlmResponse> {
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
        return Promise.resolve(
          response(JSON.stringify({ findings: findingFor(filePath) })),
        );
      }
      return Promise.resolve(
        response(JSON.stringify({ findings: crossFileFindings })),
      );
    },
    chatCompletionWithTools(messages: ChatMessage[]): Promise<LlmResponse> {
      llm.analysisPrompts.push(textOf(messages[1]));
      return Promise.resolve(response("## Analysis\nRisk on L1."));
    },
    extractionSystemPrompts: [],
  };
  return llm;
}

function finding(filePath: string, overrides: object = {}): object {
  return {
    category: "bug",
    comment: `Unchecked null in ${filePath}`,
    confidence: 0.95,
    end_line: null,
    file_path: filePath,
    line_number: 1,
    line_type: "added",
    severity: "attention",
    suggestion: "const fixed = true;",
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
    },
    {
      commitSha: COMMIT_SHA,
      maxCostUsd,
      owner: "owner",
      repo: "repo",
    },
  );
  return { host, result };
}

describe("reviewRepositoryCommit", () => {
  it("reviews the tree at the commit and publishes a neutral check run on it", async () => {
    const llm = fakeLlm((filePath) => [finding(filePath)]);

    const { host, result } = await run(
      [source("src/a.ts"), source("src/b.ts")],
      llm,
    );

    expect(host.archiveRefs).toEqual([COMMIT_SHA]);
    expect(host.created).toEqual([{ headSha: COMMIT_SHA, name: "Verqen" }]);
    expect(host.completions).toHaveLength(1);
    expect(host.completions[0]?.conclusion).toBe("neutral");
    expect(host.completions[0]?.annotations).toEqual([
      {
        line: 1,
        message: "Unchecked null in src/a.ts",
        path: "src/a.ts",
        severity: "attention",
        title: "bug",
      },
      {
        line: 1,
        message: "Unchecked null in src/b.ts",
        path: "src/b.ts",
        severity: "attention",
        title: "bug",
      },
    ]);
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
        condition: "Unchecked null in src/a.ts",
        filePath: "src/a.ts",
        line: 1,
        rule: "bug",
        severity: "attention",
      },
    ]);
    for (const reported of result.findings) {
      expect(reported).not.toHaveProperty("suggestion");
    }
    const published = JSON.stringify(host.completions);
    expect(published).not.toContain("```suggestion");
    expect(published).not.toContain("const fixed = true;");
    expect(llm.extractionSystemPrompts[0]).toContain(
      "Always set suggestion to null",
    );
  });

  it("drops a finding whose comment carries a fenced fix", async () => {
    const llm = fakeLlm((filePath) => [
      finding(filePath, {
        comment: "Wrong.\n\n```suggestion\nconst fixed = true;\n```",
      }),
    ]);

    const { host, result } = await run([source("src/a.ts")], llm);

    expect(result.findings).toEqual([]);
    expect(JSON.stringify(host.completions)).not.toContain("```");
  });

  it("drops a cross-file finding whose comment carries a fenced fix", async () => {
    const llm = fakeLlm(
      () => [],
      [
        {
          category: "architecture",
          comment: "Shared state.\n\n```ts\nexport const fixed = true;\n```",
          confidence: 0.95,
          file_path: "src/a.ts",
          line_number: 1,
          line_type: "added",
          severity: "attention",
        },
      ],
    );

    const { host, result } = await run(
      [source("src/a.ts", 80), source("src/b.ts", 80)],
      llm,
    );

    expect(result.findings).toEqual([]);
    expect(JSON.stringify(host.completions)).not.toContain("```");
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
    expect(llm.analysisPrompts).toHaveLength(1);
    expect(llm.analysisPrompts[0]).toContain("src/kept.ts");
  });

  it("reviews a 1500-line file as three separate chunks", async () => {
    const llm = fakeLlm(() => []);

    const { result } = await run([source("src/big.ts", 1500)], llm);

    expect(llm.analysisPrompts).toHaveLength(3);
    expect(llm.analysisPrompts[0]).toContain("L1 + ");
    expect(llm.analysisPrompts[1]).toContain("L601 + ");
    expect(llm.analysisPrompts[2]).toContain("L1500 + ");
    expect(result.filesReviewed).toBe(1);
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
    };
  }

  const options = {
    commitSha: COMMIT_SHA,
    maxCostUsd: 100,
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

    expect(host.archiveRefs).toEqual([]);
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

  it("closes the check run as cancelled when the review fails", async () => {
    const llm = fakeLlm(() => []);
    const host = fakeCodeHost([]);
    host.getRepositoryArchive = (): Promise<ArchiveEntry[]> =>
      Promise.reject(new Error("archive timeout"));

    await expect(
      reviewRepositoryCommit(deps(host, llm), options),
    ).rejects.toThrow("archive timeout");

    expect(host.completions).toHaveLength(1);
    expect(host.completions[0]).toMatchObject({
      annotations: [],
      conclusion: "cancelled",
    });
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
