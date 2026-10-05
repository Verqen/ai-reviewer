import { gzipSync } from "node:zlib";

import { pack } from "tar-stream";

interface TarFixtureEntry {
  content?: string;
  name: string;
  type?: "directory" | "file";
}

async function buildTarGzFixture(
  entries: readonly TarFixtureEntry[],
): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  for (const entry of entries) {
    if (entry.type === "directory") {
      tar.entry({ name: entry.name, type: "directory" });
    } else {
      tar.entry({ name: entry.name }, entry.content ?? "");
    }
  }
  tar.finalize();
  await finished;
  return gzipSync(Buffer.concat(chunks));
}

export { buildTarGzFixture };
export type { TarFixtureEntry };
