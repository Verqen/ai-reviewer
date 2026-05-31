import { Minimatch } from "minimatch";

type SkipCategory =
  | "binary"
  | "build"
  | "config"
  | "generated"
  | "lock"
  | "migration"
  | "snapshot"
  | "translation";

interface SkipRule {
  category: SkipCategory;
  matcher: Minimatch;
}

const RULE_DEFINITIONS = [
  ["lock", "**/package-lock.json"],
  ["lock", "**/yarn.lock"],
  ["lock", "**/pnpm-lock.yaml"],
  ["translation", "**/*.po"],
  ["translation", "**/*.mo"],
  ["translation", "**/locales/**"],
  ["build", "**/dist/**"],
  ["build", "**/build/**"],
  ["build", "**/node_modules/**"],
  ["snapshot", "**/__snapshots__/**"],
  ["generated", "**/*.generated.ts"],
  ["generated", "**/*.gen.ts"],
  ["generated", "**/*.d.ts"],
  ["migration", "**/migrations/**"],
  ["config", "**/package.json"],
  ["config", "**/tsconfig*.json"],
  ["config", "**/turbo.json"],
  ["config", "**/*.config.ts"],
  ["config", "**/*.config.js"],
  ["config", "**/*.config.mjs"],
  ["config", "**/*.config.cjs"],
  ["config", "**/.eslintrc*"],
  ["config", "**/.prettierrc*"],
  ["config", "**/.env"],
  ["config", "**/.env.*"],
  ["binary", "**/*.png"],
  ["binary", "**/*.jpg"],
  ["binary", "**/*.jpeg"],
  ["binary", "**/*.webp"],
  ["binary", "**/*.gif"],
  ["binary", "**/*.ico"],
  ["binary", "**/*.pdf"],
  ["binary", "**/*.woff"],
  ["binary", "**/*.woff2"],
  ["binary", "**/*.ttf"],
  ["binary", "**/*.eot"],
  ["binary", "**/*.svg"],
] as const satisfies readonly (readonly [SkipCategory, string])[];

const SKIP_RULES: readonly SkipRule[] = RULE_DEFINITIONS.map(
  ([category, pattern]) => ({
    category,
    matcher: new Minimatch(pattern, { dot: true, nocase: false }),
  })
);

function shouldSkip(path: string): boolean {
  return SKIP_RULES.some((rule) => rule.matcher.match(path));
}

function getSkipCategories(path: string): ReadonlySet<SkipCategory> {
  const categories = new Set<SkipCategory>();
  for (const rule of SKIP_RULES) {
    if (rule.matcher.match(path)) {
      categories.add(rule.category);
    }
  }
  return categories;
}

function getPrimarySkipReason(path: string): SkipCategory | null {
  for (const rule of SKIP_RULES) {
    if (rule.matcher.match(path)) {
      return rule.category;
    }
  }
  return null;
}

export {
  getPrimarySkipReason,
  getSkipCategories,
  shouldSkip,
  type SkipCategory,
};
