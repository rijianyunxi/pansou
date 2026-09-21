import Database from "better-sqlite3";
import { createJiti } from "jiti";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const dbPath = process.argv[2] || process.env.PANHUB_SQLITE_DB || resolve(projectRoot, "data/panhub.sqlite");
const jiti = createJiti(import.meta.url);
const { DEFAULT_CHANNEL_TRANSFORM } = await jiti.import(resolve(projectRoot, "server/core/source-runtime/defaults.ts"));

function removeBlock(source, pattern, label) {
  const next = source.replace(pattern, "");
  if (next === source) throw new Error(`未找到待移除的 ${label}`);
  return next;
}

function removeCloudTypes(source) {
  return source.replace(/^\s*cloud_types:\s*[^\n]+,\n/gm, "");
}

function refactorNyaa(source) {
  let next = removeBlock(source, /  var cloudTypeOf = function \(value\) \{[\s\S]*?\n  \};\n/, "Nyaa 网盘映射");
  next = next.replace(
    '  var linkOf = function (url, password) { return { type: cloudTypeOf(url), url: url, password: password || null }; };',
    '  var linkOf = function (url, password) { return context.makeLink(url, password); };',
  );
  next = next.replace('    if (!magnet || !name || !matches(name)) return null;', '    if (!link || !magnet || !name || !matches(name)) return null;');
  return removeCloudTypes(next);
}

function refactorPansearch(source) {
  let next = removeBlock(source, /  var cloudTypeOf = function \(value\) \{[\s\S]*?\n  \};\n/, "PanSearch 网盘映射");
  next = next.replace(
    '  var linkOf = function (url) {\n    var normalized = trimUrl(url);\n    return { type: cloudTypeOf(normalized), url: normalized, password: null };\n  };',
    '  var linkOf = function (url) {\n    var normalized = trimUrl(url);\n    return context.makeLink(normalized, null);\n  };',
  );
  next = next.replace(/\.filter\(function \(link\) \{ return link\.url && link\.type !== "others"; \}\)/g, '.filter(function (link) { return link && link.url && link.type !== "others"; })');
  return removeCloudTypes(next);
}

function refactorVod(source) {
  let next = removeBlock(source, /    var DRIVES = \[[\s\S]*?\n    \];\n\n/, "视频接口网盘映射");
  next = removeBlock(next, /    var LABEL_MAP = \{[\s\S]*?\n    \};\n\n/, "视频接口标签映射");
  next = removeBlock(next, /    function driveType\(url\) \{[\s\S]*?\n    \}\n\n/, "视频接口域名映射函数");
  next = removeBlock(next, /    function labelType\(label\) \{[\s\S]*?\n    \}\n\n/, "视频接口标签映射函数");
  next = next.replace(/      var froms = splitField\(pickField\(it, \['vod_down_from', 'vod_downfrom', 'vod_down_from_1'\]\)\);\n/, "");
  next = next.replace(/      var aligned = froms\.length === rawUrls\.length;\n/, "");
  next = next.replace(/      var types = \[\];\n/, "");
  next = next.replace(
    /          var tp = driveType\(url\) \|\| \(aligned \? labelType\(froms\[i\]\) : ''\) \|\| '';\n          if \(tp && types\.indexOf\(tp\) < 0\) types\.push\(tp\);\n\n          seen\[key\] = links\.length;\n          var lo = \{ url: url \};\n          if \(pwd\) lo\.password = pwd;\n          links\.push\(lo\);/,
    "          var lo = context.makeLink(url, pwd);\n          if (!lo) continue;\n          seen[key] = links.length;\n          links.push(lo);",
  );
  return removeCloudTypes(next);
}

function refactorTelegram(source) {
  let next = removeBlock(source, /    var DRIVES = \[[\s\S]*?\n    \];\n\n/, "Telegram 网盘映射");
  next = removeBlock(next, /    function driveType\(url\) \{[\s\S]*?\n    \}\n\n/, "Telegram 域名映射函数");
  next = next.replace(/      var types = \[\];\n/, "");
  next = next.replace(
    /        var tp = driveType\(url\);\n        if \(tp && types\.indexOf\(tp\) < 0\) types\.push\(tp\);\n        var lo = \{ url: url \};\n        var lp = extractPwd\(url, ''\);\n        if \(lp\) lo\.password = lp;\n        links\.push\(lo\);/,
    "        var lp = extractPwd(url, '');\n        var lo = context.makeLink(url, lp);\n        if (!lo) continue;\n        links.push(lo);",
  );
  return removeCloudTypes(next);
}

function refactorSource(row) {
  const source = row.transform;
  if (source.includes("context.makeLink")) return source;
  if (source.includes("tgme_widget_message_wrap") && source.includes("cloudTypeOf")) {
    return DEFAULT_CHANNEL_TRANSFORM;
  }
  if (row.id === "nyaa") return refactorNyaa(source);
  if (row.id === "pansearch") return refactorPansearch(source);
  if (row.id === "custom-af61755f-400f-4db4-bd49-5c9168376f8d") return refactorVod(source);
  if (row.id === "custom-cbe17eee-d61e-4c31-b5e0-9e8a4859e501") return refactorTelegram(source);
  throw new Error(`未识别的来源 transform：${row.id}`);
}

const db = new Database(dbPath);
const rows = db.prepare("SELECT id,transform FROM resource_sources ORDER BY id").all();
if (rows.length !== 14) throw new Error(`期望 14 个来源，实际找到 ${rows.length} 个`);
const updates = rows.map((row) => ({ id: row.id, transform: refactorSource(row) }));
if (updates.some((row) => !row.transform.includes("context.makeLink"))) {
  throw new Error("存在未切换到 context.makeLink 的 transform");
}
if (updates.some((row) => /cloudTypeOf|DRIVES|LABEL_MAP|LABEL_TYPES|cloud_types\s*:/.test(row.transform))) {
  throw new Error("存在残留的网盘映射或 cloud_types 输出");
}

const update = db.prepare("UPDATE resource_sources SET transform=?,updated_at=? WHERE id=?");
db.transaction(() => {
  const now = Date.now();
  for (const row of updates) update.run(row.transform, now, row.id);
})();
db.close();
console.log(`已重构 ${updates.length} 个 resource_sources.transform`);
