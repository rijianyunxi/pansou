import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const apiTarget = "http://127.0.0.1:3666";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL(".", import.meta.url)),
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  server: {
    proxy: {
      // Preserve the browser Host so same-origin credential mutations can be
      // checked by the API behind this development proxy.
      "/api": { target: apiTarget, changeOrigin: false },
      "/robots.txt": { target: apiTarget, changeOrigin: true },
      "/sitemap.xml": { target: apiTarget, changeOrigin: true },
    },
  },
  build: { sourcemap: false },
});
