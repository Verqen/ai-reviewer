import { describe, expect, it } from "vitest";

import { extractTarGzArchive } from "~/infrastructure/archive/tar-gz-archive";
import { buildTarGzFixture } from "~/test-utils/tar-gz-fixture";

describe("extractTarGzArchive", () => {
  it("returns every file with the top-level directory stripped from its path", async () => {
    const archive = await buildTarGzFixture([
      { name: "owner-repo-0123456/", type: "directory" },
      { name: "owner-repo-0123456/src/", type: "directory" },
      { content: "export {};\n", name: "owner-repo-0123456/src/index.ts" },
      { content: "# Title\n", name: "owner-repo-0123456/README.md" },
    ]);

    const entries = await extractTarGzArchive(archive);

    expect(
      entries.map((entry) => ({
        content: entry.content.toString("utf8"),
        path: entry.path,
      })),
    ).toEqual([
      { content: "export {};\n", path: "src/index.ts" },
      { content: "# Title\n", path: "README.md" },
    ]);
  });

  it("rejects a buffer that is not gzip", async () => {
    await expect(
      extractTarGzArchive(Buffer.from("not an archive")),
    ).rejects.toThrow();
  });
});
