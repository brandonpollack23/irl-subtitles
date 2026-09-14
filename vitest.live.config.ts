import { defineConfig } from "vitest/config";

/** Real-model integration runs (downloads pinned models on first use): `pnpm test:live`. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.live.test.ts", "apps/*/test/**/*.live.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
