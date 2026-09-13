import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "panhub",
    root: "./",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "test/",
        "**/.nuxt*/**",
        "**/.output/**",
        "**/.tmp/**",
        "**/*.d.ts",
        "**/config.ts",
        "**/index.ts",
      ],
    },
  },
});
