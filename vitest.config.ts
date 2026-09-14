import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "services/*/test/**/*.test.ts"],
    // Real-model runs download models and play audio in real time: vitest.live.config.ts.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
