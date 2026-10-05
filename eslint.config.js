import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
          message: "Double cast through unknown is not allowed.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/config/**",
      "src/**/*.spec.ts",
      "src/**/*.test.ts",
      "src/**/*.e2e.test.ts",
      "src/test-utils/**",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read environment variables through the schemas in src/config/.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/*.spec.ts",
      "src/**/*.test.ts",
      "src/**/*.e2e.test.ts",
      "src/**/tests/**",
      "src/test-utils/**",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: [
      "src/**/*.spec.ts",
      "src/**/*.test.ts",
      "src/**/*.e2e.test.ts",
      "src/test-utils/**",
      "scripts/**",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/logs/**",
      "eslint.config.js",
      ".prettierrc.mjs",
    ],
  },
]);
