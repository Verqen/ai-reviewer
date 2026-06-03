import { describe, expect, it } from "vitest";

import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  type TriageHunkInput,
} from "./triage.prompt";

function makeHunk(overrides: Partial<TriageHunkInput> = {}): TriageHunkInput {
  return {
    body: "+const x = 1;",
    filePath: "src/foo.ts",
    header: "@@ -1,3 +1,3 @@",
    id: 0,
    ...overrides,
  };
}

describe("triage prompt", () => {
  describe("buildTriageSystemPrompt", () => {
    it("includes trivial and needs-review criteria", () => {
      const prompt = buildTriageSystemPrompt();
      expect(prompt).toContain("trivial");
      expect(prompt).toContain("needs-review");
    });

    it("tells the model to prefer needs-review when uncertain", () => {
      const prompt = buildTriageSystemPrompt();
      expect(prompt.toLowerCase()).toContain("needs-review over trivial");
    });

    it("documents the conservative tie-break via one-phrase rationale", () => {
      const prompt = buildTriageSystemPrompt();
      expect(prompt.toLowerCase()).toContain("one short phrase");
    });

    it("requires JSON-only output with the documented schema", () => {
      const prompt = buildTriageSystemPrompt();
      expect(prompt).toContain("valid JSON only");
      expect(prompt).toContain("hunk_id");
      expect(prompt).toContain("verdict");
    });

    it("demands full coverage of every input hunk_id", () => {
      expect(buildTriageSystemPrompt()).toContain(
        "every hunk_id from the input exactly once",
      );
    });
  });

  describe("buildTriageUserPrompt", () => {
    it("embeds the hunk count in the preamble", () => {
      const prompt = buildTriageUserPrompt([makeHunk(), makeHunk({ id: 1 })]);
      expect(prompt).toContain("2 hunk(s)");
    });

    it("lists each hunk with id, file path, header and body", () => {
      const hunks: TriageHunkInput[] = [
        makeHunk({
          body: "+const foo = 1;",
          filePath: "src/a.ts",
          header: "@@ -10,3 +10,3 @@",
          id: 0,
        }),
        makeHunk({
          body: "-return bar;\n+return baz;",
          filePath: "src/b.ts",
          header: "@@ -5,1 +5,1 @@",
          id: 1,
        }),
      ];
      const prompt = buildTriageUserPrompt(hunks);

      expect(prompt).toContain("Hunk 0 (src/a.ts):");
      expect(prompt).toContain("@@ -10,3 +10,3 @@");
      expect(prompt).toContain("+const foo = 1;");
      expect(prompt).toContain("Hunk 1 (src/b.ts):");
      expect(prompt).toContain("-return bar;");
      expect(prompt).toContain("+return baz;");
    });

    it("separates hunks with a divider so long diffs remain parseable", () => {
      const prompt = buildTriageUserPrompt([makeHunk(), makeHunk({ id: 1 })]);
      expect(prompt).toContain("---");
    });

    it("reminds how to read each separated block", () => {
      expect(
        buildTriageUserPrompt([makeHunk(), makeHunk({ id: 1 })]),
      ).toContain("numbered block");
    });

    it("handles a single hunk without separators", () => {
      const prompt = buildTriageUserPrompt([makeHunk()]);
      expect(prompt).toContain("1 hunk(s)");
      expect(prompt).not.toContain("---");
    });

    it("matches a stable snapshot for a fixed batch (guards against accidental prompt drift)", () => {
      const hunks: TriageHunkInput[] = [
        {
          body: "+const foo = 1;",
          filePath: "src/a.ts",
          header: "@@ -1,1 +1,1 @@",
          id: 0,
        },
        {
          body: "-return bar;\n+return baz;",
          filePath: "src/b.ts",
          header: "@@ -5,1 +5,1 @@",
          id: 1,
        },
      ];
      expect(buildTriageUserPrompt(hunks)).toMatchInlineSnapshot(`
        "Classify the following 2 hunk(s):

        Each numbered block below is one hunk; use the file path together with added/removed lines.

        Hunk 0 (src/a.ts):
        <untrusted_diff_hunk>
        @@ -1,1 +1,1 @@
        +const foo = 1;
        </untrusted_diff_hunk>

        ---

        Hunk 1 (src/b.ts):
        <untrusted_diff_hunk>
        @@ -5,1 +5,1 @@
        -return bar;
        +return baz;
        </untrusted_diff_hunk>"
      `);
    });
  });
});
