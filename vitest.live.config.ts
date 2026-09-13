import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "panhub-live",
    root: "./",
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 60_000,
  },
});
