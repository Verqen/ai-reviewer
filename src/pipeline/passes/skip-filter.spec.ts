import { describe, expect, it } from "vitest";

import type { SkipCategory } from "~/domain/types/skip.types";

import {
  getPrimarySkipReason,
  getSkipCategories,
  shouldSkip,
} from "./skip-filter";

describe("skip-filter", () => {
  describe("shouldSkip", () => {
    const skippedPaths: readonly [string, string][] = [
      ["package-lock.json", "lock file at root"],
      ["apps/web/package-lock.json", "nested lock file"],
      ["yarn.lock", "yarn lock at root"],
      ["services/api/yarn.lock", "nested yarn lock"],
      ["pnpm-lock.yaml", "pnpm lock at root"],
      ["monorepo/pnpm-lock.yaml", "nested pnpm lock"],
      ["src/locales/ru.po", "gettext translation"],
      ["i18n/messages.mo", "compiled translation"],
      ["locales/ru/messages.json", "file in locales directory"],
      ["dist/index.js", "build output at root"],
      ["apps/web/dist/bundle.js", "nested build output"],
      ["build/output.js", "build directory"],
      ["node_modules/react/index.js", "vendored dependency"],
      ["src/__snapshots__/foo.snap", "test snapshot"],
      ["__snapshots__/mytest.snap.js", "root snapshot dir"],
      ["src/api.generated.ts", "generated source"],
      ["generated/code.gen.ts", "short-suffix generated source"],
      ["src/types.d.ts", "type declaration"],
      ["index.d.ts", "type declaration at root"],
      ["public/logo.png", "png asset"],
      ["assets/photo.jpg", "jpg asset"],
      ["assets/background.jpeg", "jpeg asset"],
      ["images/optimized.webp", "webp asset"],
      ["assets/animation.gif", "gif asset"],
      ["public/favicon.ico", "ico asset"],
      ["docs/guide.pdf", "pdf asset"],
      ["fonts/roboto.woff", "woff font"],
      ["fonts/opensans.woff2", "woff2 font"],
      ["public/fonts/arial.ttf", "ttf font"],
      ["assets/fonts/custom.eot", "eot font"],
      ["icons/menu.svg", "svg asset"],
      ["package.json", "package manifest"],
      ["apps/web/package.json", "nested package manifest"],
      ["tsconfig.json", "tsconfig at root"],
      ["services/api/tsconfig.build.json", "nested tsconfig variant"],
      ["vitest.config.ts", "vitest config"],
      ["eslint.config.js", "eslint flat config"],
      ["apps/web/next.config.mjs", "next.js config"],
      ["services/api/turbo.json", "turbo manifest"],
      [".env", "dotenv root"],
      [".env.example", "dotenv example"],
      ["services/api/.env.production", "nested dotenv variant"],
      [".eslintrc.json", "legacy eslint rc"],
      [".prettierrc", "prettier rc"],
      ["services/api/migrations/20260416-init.ts", "ts migration"],
      ["apps/server/src/db/migrations/001_create_users.sql", "sql migration"],
    ];

    const reviewablePaths: readonly [string, string][] = [
      ["src/utils.ts", "typescript source"],
      ["src/api/handler.ts", "nested typescript source"],
      ["src/components/Button.tsx", "tsx component"],
      ["src/index.js", "javascript source"],
      ["README.md", "markdown doc"],
      ["docs/architecture.md", "nested markdown doc"],
      [
        "src/utils.spec.ts",
        "unit test (still reviewable — contains business rules)",
      ],
    ];

    it.each(skippedPaths)("skips %s (%s)", (path) => {
      expect(shouldSkip(path)).toBe(true);
    });

    it.each(reviewablePaths)("does not skip %s (%s)", (path) => {
      expect(shouldSkip(path)).toBe(false);
    });
  });

  describe("getSkipCategories", () => {
    it("returns empty set for reviewable files", () => {
      expect(getSkipCategories("src/utils.ts").size).toBe(0);
      expect(getSkipCategories("src/App.tsx").size).toBe(0);
    });

    it.each<[string, SkipCategory]>([
      ["package-lock.json", "lock"],
      ["locales/ru.po", "translation"],
      ["dist/bundle.js", "build"],
      ["src/__snapshots__/foo.snap", "snapshot"],
      ["src/api.generated.ts", "generated"],
      ["public/logo.png", "binary"],
      ["package.json", "config"],
      ["tsconfig.json", "config"],
      ["vitest.config.ts", "config"],
      [".env.example", "config"],
      ["services/api/migrations/001-init.ts", "migration"],
    ])("categorises %s as %s", (path, category) => {
      expect(getSkipCategories(path).has(category)).toBe(true);
    });

    it("captures all matching categories for paths hitting multiple rules", () => {
      const categories = getSkipCategories("dist/api.generated.ts");
      expect(categories.has("build")).toBe(true);
      expect(categories.has("generated")).toBe(true);
      expect(categories.size).toBe(2);
    });
  });

  describe("getPrimarySkipReason", () => {
    it("returns null for reviewable files", () => {
      expect(getPrimarySkipReason("src/utils.ts")).toBeNull();
    });

    it.each<[string, SkipCategory]>([
      ["package-lock.json", "lock"],
      ["locales/ru.po", "translation"],
      ["dist/bundle.js", "build"],
      ["src/__snapshots__/foo.snap", "snapshot"],
      ["src/api.generated.ts", "generated"],
      ["public/logo.png", "binary"],
      ["package.json", "config"],
      ["tsconfig.json", "config"],
      ["services/api/migrations/001-init.ts", "migration"],
    ])("returns %s → %s", (path, expected) => {
      expect(getPrimarySkipReason(path)).toBe(expected);
    });

    it("prefers the earlier rule when multiple match (stable label for counter)", () => {
      expect(getPrimarySkipReason("dist/api.generated.ts")).toBe("build");
    });
  });
});
