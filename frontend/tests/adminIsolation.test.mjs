import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, compileScript } from "@vue/compiler-sfc";
const root = fileURLToPath(new URL("../", import.meta.url));
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      ),
    )
  ).flat();
}

test("admin is lazy-loaded behind exactly one layout", async () => {
  const routes = await readFile(path.join(root, "src/main.ts"), "utf8");
  assert.equal(
    (
      routes.match(
        /import\(['"]\.\.\/components\/admin\/AdminLayout.vue['"]\)/g,
      ) || []
    ).length,
    1,
  );
  assert.match(routes, /children:\s*\[/);
  assert.doesNotMatch(
    routes,
    /import\s+\w+\s+from\s+['"][^'"]*(?:admin|monitor|sources)[^'"]*['"]/,
  );
});
test("no global preflight/reset and no public page imports admin styles", async () => {
  const css = await readFile(path.join(root, "assets/admin.css"), "utf8");
  assert.doesNotMatch(
    css,
    /@import\s+['"]tailwindcss(?:\/preflight\.css)?['"]/,
  );
  for (const name of [
    "app.vue",
    "pages/index/index.vue",
    "pages/copyright.vue",
  ]) {
    assert.doesNotMatch(
      await readFile(path.join(root, name), "utf8"),
      /admin\.css|components\/admin\/ui/,
    );
  }
});
test("all management Vue templates compile after component migration", async () => {
  for (const dir of [
    "components/admin",
    "components/sources",
    "components/monitor",
    "pages/admin",
  ]) {
    for (const file of (await files(path.join(root, dir))).filter((f) =>
      f.endsWith(".vue"),
    )) {
      const { errors } = parse(await readFile(file, "utf8"), {
        filename: file,
      });
      assert.deepEqual(errors, [], file);
    }
  }
});
test("checked-only wrapper explicitly disables Vue absent Boolean casting", async () => {
  const file = path.join(root, "components/admin/AdminCheckbox.vue");
  const { descriptor } = parse(await readFile(file, "utf8"), {
    filename: file,
  });
  const script = compileScript(descriptor, {
    id: "admin-checkbox-test",
  }).content;
  assert.match(script, /modelValue:\s*\{[^}]*default:\s*undefined/);
});
test("generated utility literals are prefixed but enum comparisons are not", async () => {
  for (const file of (
    await files(path.join(root, "components/admin/ui"))
  ).filter((f) => f.endsWith(".vue"))) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /(?:===|!==)\s*['"]tw:/, file);
    for (const literal of source.match(/\x60[^\x60]+\x60/g) || []) {
      if (literal.includes("border-input") || literal.includes("bg-primary")) {
        for (const token of literal.slice(1, -1).split(/\s+/).filter(Boolean))
          assert.ok(token.startsWith("tw:"), file + ": " + token);
      }
    }
  }
});

test("admin layout keeps breadcrumbs and content without redundant page headings", async () => {
  const layout = await readFile(path.join(root, "components/admin/AdminLayout.vue"), "utf8");
  const css = await readFile(path.join(root, "assets/admin.css"), "utf8");
  assert.match(layout, /class="admin-breadcrumb"/);
  assert.match(layout, /current\?\.title/);
  assert.match(layout, /<section class="admin-main">\s*<RouterView \/>\s*<\/section>/);
  assert.doesNotMatch(layout, /admin-page-heading|admin-eyebrow|PANSOU \/ CONSOLE/);
  assert.doesNotMatch(css, /admin-page-heading|admin-eyebrow/);
});
