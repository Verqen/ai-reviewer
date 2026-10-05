import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { extract as tarExtract } from "tar-stream";

import type { ArchiveEntry } from "~/domain/types/code-host.types";

function withoutTopLevelDirectory(name: string): string {
  return name.split("/").slice(1).join("/");
}

async function extractTarGzArchive(archive: Buffer): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const gunzip = createGunzip();
  const tar = tarExtract();

  await new Promise<void>((resolve, reject) => {
    tar.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (header.type === "file" && header.name) {
          const filePath = withoutTopLevelDirectory(header.name);
          if (filePath) {
            entries.push({ content: Buffer.concat(chunks), path: filePath });
          }
        }
        next();
      });
      stream.resume();
    });
    tar.on("finish", resolve);
    tar.on("error", reject);
    gunzip.on("error", reject);
    Readable.from(archive).pipe(gunzip).pipe(tar);
  });

  return entries;
}

export { extractTarGzArchive };
