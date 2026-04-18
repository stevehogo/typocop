import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts", "tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 60_000,
  },
});
