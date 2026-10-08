import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("production HTML and module graph need no third-party runtime host", { timeout: 120_000 }, async () => {
  const temporaryRoot = path.resolve(tmpdir());
  const output = await mkdtemp(path.join(temporaryRoot, "pansou-local-assets-"));
  assert.equal(path.dirname(path.resolve(output)), temporaryRoot);
  assert.ok(path.basename(output).startsWith("pansou-local-assets-"));
  try {
    const result = await build({
      root,
      configFile: path.join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: output, emptyOutDir: true },
    });
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]);
    const preloads = [...html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/g)].map(match => match[1]);
    assert.ok(scripts.length > 0, "production HTML must load the application");
    for (const url of [...scripts, ...preloads]) {
      assert.match(url, /^\/assets\//, `runtime asset must be served locally: ${url}`);
      await readFile(path.join(output, url.slice(1)));
    }
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com/);
    const assets = await readdir(path.join(output, "assets"));
    const vendor = assets.find(name => /^vue-vendor-.*\.js$/.test(name));
    assert.ok(vendor, "Vue and the router must have a local vendor chunk");
    assert.ok((await readFile(path.join(output, "assets", vendor))).length > 10_000);
    // Rollup metadata describes actual module dependencies; a text regex would
    // confuse UI strings such as "import" with JavaScript module syntax.
    const bundles = Array.isArray(result) ? result : [result];
    const emitted = new Set(bundles.flatMap(bundle => bundle.output.map(asset => asset.fileName)));
    for (const bundle of bundles) {
      for (const chunk of bundle.output.filter(asset => asset.type === "chunk")) {
        for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
          assert.ok(emitted.has(specifier), `${chunk.fileName} has an external dependency: ${specifier}`);
          await readFile(path.join(output, specifier));
        }
      }
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
