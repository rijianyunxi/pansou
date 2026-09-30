import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, compileTemplate } from "@vue/compiler-sfc";
import postcss from "postcss";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFile(path.join(root, name), "utf8");
function elements(node) {
  return (node.children || []).filter((child) => child.type === 1);
}
function find(node, predicate) {
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node).flatMap((child) => find(child, predicate)),
  ];
}
function className(node) {
  return (
    node.props?.find((prop) => prop.name === "class")?.value?.content || ""
  );
}
async function files(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : path.join(dir, e.name),
      ),
    )
  ).flat();
}
test("business overlays use one visible accessible header and close control", async () => {
  const source = await read("components/admin/AdminDialog.vue");
  assert.match(source, /:show-close-button="false"/);
  assert.equal((source.match(/aria-label="关闭窗口"/g) || []).length, 1);
  assert.match(source, /class="admin-dialog-title"/);
  assert.match(source, /class="admin-dialog-body"/);
  assert.match(source, /@interact-outside.prevent/);
  assert.ok(source.includes("if (!value && !busy)"));
  const sheet = await read("components/admin/ui/sheet/SheetContent.vue");
  assert.match(sheet, /v-if="showCloseButton"/);
});
test("modal form actions stay outside their scrollable field area", async () => {
  let count = 0;
  for (const file of [
    "AdminFeaturePage",
    "ProxyNodesPage",
    "AdminResourcesPage",
    "AdminHotSearchPage",
  ]) {
    const ast = parse(await read("components/admin/" + file + ".vue"))
      .descriptor.template.ast;
    for (const form of find(
      ast,
      (n) => n.tag === "form" && className(n).includes("admin-dialog-form"),
    )) {
      const children = elements(form);
      assert.equal(
        children.filter((n) => className(n) === "admin-form-fields").length,
        1,
        file,
      );
      assert.equal(
        children.filter((n) =>
          /^(admin-modal-actions|modal-actions)$/.test(className(n)),
        ).length,
        1,
        file,
      );
      assert.equal(
        find(
          children.find((n) => className(n) === "admin-form-fields"),
          (n) => /^(admin-modal-actions|modal-actions)$/.test(className(n)),
        ).length,
        0,
        file,
      );
      count++;
    }
  }
  assert.equal(count, 4);
});
test("page-local dialog headers are not duplicated inside the shared dialog", async () => {
  for (const dir of [
    "components/admin",
    "components/sources",
    "components/monitor",
  ]) {
    for (const file of (await files(path.join(root, dir))).filter((f) =>
      f.endsWith(".vue"),
    )) {
      const ast = parse(await readFile(file, "utf8")).descriptor.template?.ast;
      if (!ast) continue;
      for (const modal of find(ast, (n) => n.tag === "AdminDialog")) {
        for (const content of elements(modal)) {
          assert.ok(
            !elements(content).some(
              (n) => n.tag === "header" || className(n) === "modal-header",
            ),
            file,
          );
        }
      }
    }
  }
});
test("all management templates actually compile, not just parse", async () => {
  for (const dir of [
    "components/admin",
    "components/sources",
    "components/monitor",
    "pages/admin",
  ]) {
    for (const file of (await files(path.join(root, dir))).filter((f) =>
      f.endsWith(".vue"),
    )) {
      const { descriptor } = parse(await readFile(file, "utf8"));
      if (!descriptor.template) continue;
      const compiled = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: "admin-layout-test",
      });
      assert.deepEqual(compiled.errors, [], file);
    }
  }
});
test("layout and overlay styles cannot target public pages", async () => {
  for (const file of ["assets/admin-layout.css", "assets/admin-overlays.css"]) {
    const ast = postcss.parse(await read(file));
    ast.walkRules((rule) => {
      if (
        rule.parent.type === "atrule" &&
        rule.parent.name.includes("keyframes")
      )
        return;
      for (const selector of rule.selectors)
        assert.ok(
          selector.trim().startsWith(".admin-root"),
          file + ": " + selector,
        );
    });
  }
});
test("mobile control geometry overrides public min-size rules within admin only", async () => {
  const css = postcss.parse(await read("assets/admin-layout.css"));
  for (const [slot, width] of [
    ["switch", "32px"],
    ["checkbox", "16px"],
  ]) {
    let found = false;
    css.walkRules((rule) => {
      if (rule.selector === '.admin-root [data-slot="' + slot + '"]') {
        const declarations = Object.fromEntries(
          rule.nodes
            .filter((n) => n.type === "decl")
            .map((n) => [n.prop, n.value]),
        );
        if (declarations["min-width"] === width && declarations["min-height"])
          found = true;
      }
    });
    assert.ok(found, slot + " must not inherit the public 44px mobile minimum");
  }
});
test("legacy scoped business styles are below shadcn utilities in the cascade", async () => {
  for (const dir of [
    "components/admin",
    "components/sources",
    "components/monitor",
    "pages/admin",
  ]) {
    for (const file of (await files(path.join(root, dir))).filter(
      (f) => f.endsWith(".vue") && !f.includes(path.sep + "ui" + path.sep),
    )) {
      const { descriptor } = parse(await readFile(file, "utf8"));
      for (const style of descriptor.styles.filter((s) => s.scoped))
        assert.match(style.content, /@layer components/, file);
    }
  }
});
test("node library does not expose business strategy binding",async()=>{const page=await read("components/admin/ProxyNodesPage.vue");assert.ok(!page.includes("新增策略"));assert.ok(page.includes("referenceCount"));assert.match(page,/if\s*\(busy.value\)\s*return/);});

test("source editor stays open on save failure and exposes a persistent error", async () => {
  const editor = await read("components/sources/SourceEditor.vue");
  const page = await read("pages/admin/[...view].vue");
  assert.ok(editor.includes('emit("save", JSON.parse(JSON.stringify(form)));'));
  assert.ok(!editor.includes('emit("close");'));
  assert.ok(editor.includes("error || saveError"));
  assert.ok(page.includes("sourceSaveError.value = apiErrorMessage(error)"));
  assert.ok(page.includes(':saving="sourceSaving"'));
});

test("wide tables expose keyboard scrolling and a visible overflow hint", async () => {
  const table = await read("components/admin/ui/table/Table.vue");
  assert.ok(table.includes("new ResizeObserver(measure)"));
  assert.ok(table.includes(':tabindex="scrollable ? 0 : undefined"'));
  assert.ok(table.includes('v-if="scrollable"'));
  assert.ok(table.includes("observer?.disconnect()"));
});

test("resource columns remain bounded and row actions stay reachable", async () => {
  const css = await read("assets/admin-layout.css");
  assert.match(
    css,
    /\.admin-root \.source-table\.resource-table\s*\{[^}]*table-layout:\s*fixed/s,
  );
  assert.match(
    css,
    /\.admin-root \.source-table\.resource-table \.action-column\s*\{[^}]*position:\s*sticky/s,
  );
  const page = await read("components/admin/AdminResourcesPage.vue");
  assert.ok(page.includes('<strong :title="item.name">'));
});
