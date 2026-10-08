import { fileURLToPath, URL } from "node:url";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

const compressGzip = promisify(gzip);

function precompressAssets(): Plugin {
  let outputDir: string;
  return {
    name: "pansou-precompress-gzip",
    apply: "build",
    configResolved(config) {
      outputDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      async function compressDirectory(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            await compressDirectory(path);
          } else if (/\.(?:html|js|css|svg|json|txt|xml)$/.test(entry.name)) {
            const source = await readFile(path);
            const compressed = await compressGzip(source, { level: 9 });
            if (compressed.length < source.length) await writeFile(path + ".gz", compressed);
          }
        }
      }
      await compressDirectory(outputDir);
    },
  };
}

const apiTarget = "http://127.0.0.1:3666";

export default defineConfig({
  plugins: [vue(), tailwindcss(), precompressAssets()],
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
    minify: "terser",
    cssMinify: "esbuild",
    terserOptions: {
      compress: { passes: 3, drop_debugger: true },
      mangle: true,
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        // Keep Vue and the router in a locally served, independently cacheable
        // chunk. Runtime versions come from package-lock.json, not a CDN URL.
        manualChunks: {
          "vue-vendor": ["vue", "vue-router"],
        },
      },
    },
  },
});
