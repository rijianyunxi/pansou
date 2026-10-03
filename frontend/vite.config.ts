import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const apiTarget = "http://127.0.0.1:3666";

// vue 从公共 CDN 以 ES Module 加载，不打进业务包。必须与 package.json 的
// vue 版本严格一致（构建产物/API 行为与类型保持同一版本）。
const vueCdnUrl = "https://cdn.jsdelivr.net/npm/vue@3.5.43/dist/vue.runtime.esm-browser.prod.js";

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
  build: {
    sourcemap: false,
    rollupOptions: {
      // 仅外置裸导入 "vue"（不影响 vue-router）；所有依赖库的 import 都会被
      // 重写到 CDN 地址，浏览器端仍是同一个模块实例。
      external: [/^vue$/],
      output: {
        paths: { vue: vueCdnUrl },
      },
    },
  },
});
