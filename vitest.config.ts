import { resolve } from "path";

import { defineConfig } from "vitest/config";

const alias = { "~": resolve(__dirname, "./src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          environment: "node",
          include: ["src/**/*.spec.ts"],
          name: "unit",
        },
      },
      {
        resolve: { alias },
        test: {
          hookTimeout: 300_000,
          include: ["src/**/*.test.ts"],
          name: "integration",
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          hookTimeout: 300_000,
          include: ["src/**/*.e2e.test.ts"],
          name: "e2e",
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          testTimeout: 60_000,
        },
      },
    ],
  },
});
