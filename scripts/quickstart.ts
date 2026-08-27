import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

const ENV_PATH = resolve(process.cwd(), ".env");
const API_KEY_NAME = "OPENROUTER_API_KEY";
const API_KEY_URL = "https://openrouter.ai/keys";
const ENV_LINE_PATTERN = /^([A-Z0-9_]+)=(.*)$/;

function readEnvFileLines(): string[] {
  if (!existsSync(ENV_PATH)) {
    return [];
  }
  return readFileSync(ENV_PATH, "utf-8").split("\n");
}

function findEnvFileValue(name: string): string | undefined {
  for (const line of readEnvFileLines()) {
    const match = ENV_LINE_PATTERN.exec(line.trim());
    const key = match?.[1];
    const value = match?.[2]?.trim();
    if (key === name && value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function findConfiguredApiKey(): string | undefined {
  const fromProcess = process.env[API_KEY_NAME]?.trim();
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return fromProcess;
  }
  return findEnvFileValue(API_KEY_NAME);
}

function persistApiKey(apiKey: string): void {
  const entry = `${API_KEY_NAME}=${apiKey}`;
  const lines = readEnvFileLines();
  let replaced = false;
  const updated = lines.map((line) => {
    const key = ENV_LINE_PATTERN.exec(line.trim())?.[1];
    if (key !== API_KEY_NAME || replaced) {
      return line;
    }
    replaced = true;
    return entry;
  });
  if (!replaced) {
    updated.push(entry);
  }
  const body = updated.join("\n").replace(/\n+$/, "");
  writeFileSync(ENV_PATH, `${body}\n`, "utf-8");
}

async function ask(
  rl: Interface,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(`  ${question} [${fallback}]: `)).trim();
  return answer.length > 0 ? answer : fallback;
}

function resolveRepoPath(input: string): string {
  const repoPath = resolve(input);
  if (!existsSync(resolve(repoPath, ".git"))) {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  return repoPath;
}

async function collectApiKey(rl: Interface): Promise<void> {
  if (findConfiguredApiKey() !== undefined) {
    stdout.write(`  ${API_KEY_NAME} found, reusing it.\n\n`);
    return;
  }
  stdout.write(`  No ${API_KEY_NAME} yet. Get one at ${API_KEY_URL}\n`);
  const apiKey = (await rl.question(`  ${API_KEY_NAME}: `)).trim();
  if (apiKey.length === 0) {
    throw new Error(`${API_KEY_NAME} is required to call a model`);
  }
  persistApiKey(apiKey);
  stdout.write(`  Saved to .env\n\n`);
}

async function main(): Promise<void> {
  if (!stdin.isTTY) {
    stdout.write(
      "quickstart needs an interactive terminal.\n" +
        "Non-interactive equivalent: pnpm run scan -- --base main --head HEAD\n",
    );
    process.exit(1);
  }

  stdout.write("\nAI Reviewer quickstart\n");
  stdout.write("Reviews a real diff and prints the findings.\n");
  stdout.write("No database, no code host, no webhook. Nothing is posted.\n\n");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await collectApiKey(rl);
    const repoPath = resolveRepoPath(
      await ask(rl, "Repository to review", process.cwd()),
    );
    const base = await ask(rl, "Compare from", "main");
    const head = await ask(rl, "Compare to", "HEAD");
    stdout.write(`\n  Reviewing ${base}...${head} in ${repoPath}\n\n`);

    const result = spawnSync(
      "pnpm",
      ["run", "scan", "--", "--repo", repoPath, "--base", base, "--head", head],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  stdout.write(
    `\nquickstart failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
