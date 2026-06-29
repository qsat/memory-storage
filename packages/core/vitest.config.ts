import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // types.ts is type-only (no runtime code); exclude to avoid a 0% noise row.
      exclude: ["src/**/*.test.ts", "src/types.ts"],
      // text: console; json-summary + json: consumed by the PR coverage action.
      reporter: ["text", "json-summary", "json", "html"],
      reportOnFailure: true,
    },
  },
});
