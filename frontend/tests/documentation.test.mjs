import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const documents = ["README.md", "migrations/README.md",
  ...(await readdir(path.join(root, "docs"))).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];

test("maintained documentation has no broken local Markdown links", async () => {
  for (const document of documents) {
    const text = await readFile(path.join(root, document), "utf8");
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const filename = decodeURIComponent(target.split("#")[0]);
      await assert.doesNotReject(access(path.resolve(root, path.dirname(document), filename)),
        `${document} links to missing ${target}`);
    }
  }
});

test("migration guide names every shipped SQL migration and does not invent the next version", async () => {
  const guide = await readFile(path.join(root, "migrations/README.md"), "utf8");
  const migrations = (await readdir(path.join(root, "migrations"))).filter(name => /^\d+_.*\.sql$/.test(name));
  for (const migration of migrations) assert.ok(guide.includes(migration), `missing migration: ${migration}`);
  const latest = Math.max(...migrations.map(name => Number(name.split("_")[0])));
  const next = String(latest + 1).padStart(3, "0");
  assert.ok(guide.includes(`后续迁移从 \`${next}\``), "next migration version must match the directory");
  assert.match(guide, /不能直接启动|不可直接启动/);
  assert.match(guide, /不要.*删除.*迁移记录/);
});

test("README describes local runtime assets and current failed-message storage", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /vue-vendor/);
  assert.doesNotMatch(readme, /仅 Rust 后端解密读取|采集原文只在解析过程中临时使用，不长期保存|后续编号从 046 开始/);
  assert.match(readme, /失败消息.*原始 HTML/);
});
