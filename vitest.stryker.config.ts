import { resolve } from "path";

import { defineConfig } from "vitest/config";

const alias = { "~": resolve(__dirname, "./src") };

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
