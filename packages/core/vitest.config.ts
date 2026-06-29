import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      // text: console; json-summary + json: consumed by the PR coverage action.
      reporter: ["text", "json-summary", "json", "html"],
      reportOnFailure: true,
    },
  },
});
