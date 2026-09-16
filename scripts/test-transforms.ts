import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_CHANNEL_TRANSFORM } from "../server/core/source-runtime/defaults";

const configured = process.argv.includes("--configured");
const db = configured ? new Database(process.env.PANHUB_SQLITE_DB || "data/panhub.sqlite", { readonly: true }) : null;
const sources: any[] = db ? db.prepare("SELECT * FROM resource_sources ORDER BY id").all().map((source: any) => ({ ...source, channelSource: /t\.me\/s\//.test(source.url) })) : [
  { id: "channel-fixture", channelSource: true, format: "html", transform: DEFAULT_CHANNEL_TRANSFORM },
  ...["hunhepan", "pansearch", "nyaa"].map(id => ({ id, channelSource: false, format: id === "hunhepan" ? "json" : "html", transform: readFileSync(`scripts/fixtures/transforms/${id}.js`, "utf8").replace(/^export default /, "").replace(/;\s*$/, "") })),
];
db?.close();
if (!configured) process.env.PANHUB_SQLITE_DB = ":memory:";
const { executeSourceTransform } = await import("../server/core/source-runtime/runtime");
let count = 0;
const failures: string[] = [];
function check(label: string, fn: () => void) { try { fn(); count++; } catch (error) { failures.push(`${label}: ${error}`); } }
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const url = "https://www.alipan.com/s/FhvaDHpLXyg";
const cases = [
  { title: "测试资源", text: `【标题】：测试资源\n${url}` },
  { title: "天久鹰央的推理病历表 (2025)", text: `📺 影片更新通知~\n\n电视剧名：天久鹰央的推理病历表 (2025)\n类型：动画\n${url}` },
  { title: "Fights Break Sphere / 斗破苍穹", text: `◎译　　名　Fights Break Sphere / 斗破苍穹\n◎片　　名　斗破苍穹觉醒2023\n${url}` },
  { title: "【电影】斗破苍穹3", text: `【电影】斗破苍穹3|${url}` },
  { title: "触碰你 ふれる。 (2024)", text: `名称：触碰你 ふれる。 (2024)\n描述：自幼在岛上相识相伴成长的挚友，一起来到东京。\n链接：${url}` },
  { title: "斗破苍穹 (2017)", text: "🎬 斗破苍穹 (2017)\n\n🎭 类型：剧集\n⭐ TMDB评分：8.2/10\n🍅 豆瓣评分：5.5\n🖥 画质：\n📹 视频：\n💬 字幕：简中（内嵌）\n📦 大小：1002.06MB\n👤 分享：匿名\n\nS05E203 4K WEB-DL H.265 10bit 25fps [国语][内嵌简中字幕]\n🔗 链接：123网盘\n📖 简介：\n萧炎曾是家族里公认的斗气天才。", href: "https://www.123865.com/s/example" },
  { title: "测试资源 (2024)", text: `📦 资源名称：测试资源 (2024)\n简介：完整剧情\n链接：${url}\n提取码：aB12` },
  { title: "测试资源", text: `名称：\n测试资源\n描述：内容\n${url}` },
  { title: "测试资源", text: `**名称：测试资源**\n描述：内容\n[阿里云盘](${url})` },
  { title: "测试资源", text: `名称：测试资源 描述：内容 链接：${url}` },
  { title: "测试资源 4K", text: `测试资源 4K\n${url}` },
];
for (const source of sources) {
  const run = (raw: string, keyword = "") => executeSourceTransform({ id: source.id, version: "test", format: source.format, maxResults: 200, code: source.transform }, raw, { rawBody: raw, format: source.format, keyword, source: source.id });
  if (source.channelSource) {
    for (const [i, c] of cases.entries()) for (const mode of ["br", "newline", "paragraph"]) {
      check(`${source.id} case ${i} ${mode}`, () => {
        const body = escape(c.text).split("\n");
        const html = mode === "paragraph" ? body.map(line => `<p>${line}</p>`).join("") : body.join(mode === "br" ? "<br>" : "\n");
        const raw = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="example/123"><div class="tgme_widget_message_text">${html}${c.href ? `<a href="${c.href}">123网盘</a>` : ""}</div><time datetime="2026-09-15T08:00:00Z"></time></div></div>`;
        const result = run(raw);
        assert.equal(result.length, 1); assert.equal(result[0]!.name, c.title);
        assert.equal(result[0]!.links.length, 1); assert.equal(result[0]!.links[0]!.url, c.href || url);
        assert.equal(result[0]!.links[0]!.type, c.href ? "123" : "aliyun");
        if (c.text.includes("提取码：aB12")) assert.equal(result[0]!.links[0]!.password, "aB12");
        assert.equal(run(raw, "完全不匹配").length, 0);
      });
    }
    check(`${source.id} empty`, () => assert.equal(run("<html>no messages</html>").length, 0));
    const wrap = (text: string, id: number) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="example/${id}"><div class="tgme_widget_message_text">${text}</div></div></div>`;
    check(`${source.id} unrelated links rejected`, () => assert.equal(run(wrap('名称：测试<br><a href="https://t.me/example">频道</a><a href="https://example.com/ads">广告</a>', 1)).length, 0));
    check(`${source.id} duplicate links`, () => assert.equal(run(wrap(`名称：测试<br>${url}<br><a href="${url}">下载</a>`, 1))[0]!.links.length, 1));
    check(`${source.id} URL-only message rejected`, () => assert.equal(run(wrap(url, 1)).length, 0));
    check(`${source.id} HTML post isolation`, () => {
      const result = run(wrap(`名称：测试一<br>${url}`, 1) + wrap(`名称：测试二<br>https://pan.quark.cn/s/example`, 2));
      assert.deepEqual(Array.from(result, r => r.name), ['测试一', '测试二']); assert.notEqual(result[0]!.id, result[1]!.id);
    });
  } else if (source.id === "hunhepan") {
    check(`${source.id} contract`, () => {
      const results = run(JSON.stringify({ data: { list: [{ disk_id: 12, disk_name: "<em>测试</em>资源", files: "文件描述", link: url, disk_pass: "a123", update_time: "2026-08-07 13:09:03" }, { disk_name: "坏链接", link: "javascript:alert(1)" }] } }));
      assert.equal(results.length, 1); assert.equal(results[0]!.name, "测试资源"); assert.equal(results[0]!.links[0]!.password, "a123"); assert.ok(results[0]!.datetime);
    });
    check(`${source.id} empty`, () => assert.equal(run('{}').length, 0));
    check(`${source.id} business error`, () => assert.throws(() => run('{"code":0,"msg":"参数错误","data":null}'), /参数错误/));
  } else if (source.id === "pansearch") {
    check(`${source.id} contract`, () => {
      const payload = {
        props: {
          pageProps: {
            data: {
              data: [
                { id: "single-1", time: "2026-09-15 12:34:56", content: "名称：测试电影\n描述：一条测试资源\n链接：https://pan.baidu.com/s/abc123" },
                { id: "numbered-1", time: "2026-09-15 13:00:00", content: "1、测试剧集\nhttps://pan.quark.cn/s/quark123\n2、无效广告\nhttps://example.com/ad" },
                { id: "unsupported-1", time: "2026-09-15 14:00:00", content: "名称：无效资源\n链接：https://example.com/not-a-cloud-link" },
              ],
            },
          },
        },
      };
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
      const results = run(html, "测试");
      assert.equal(results.length, 2);
      assert.equal(JSON.stringify(results.map((item) => item.name)), JSON.stringify(["测试电影", "测试剧集"]));
      assert.equal(results[0]!.links[0]!.type, "baidu");
      assert.equal(results[1]!.links[0]!.type, "quark");
    });
    check(`${source.id} empty`, () => {
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data: { data: [] } } } })}</script>`;
      assert.equal(run(html, "测试").length, 0);
    });
  } else if (source.id === "nyaa") {
    check(`${source.id} title vs comments`, () => {
      const result = run('<table class="torrent-list"><tbody><tr><td></td><td><a class="comments" href="/view/123#comments">99</a><a href="/view/123" title="Test 1080p">Test</a></td><td><a href="magnet:?xt=urn:btih:123&amp;dn=Test">link</a></td><td>1 GB</td><td data-timestamp="1700000000"></td></tr></tbody></table>', 'Test');
      assert.equal(result.length, 1); assert.equal(result[0]!.name, "Test 1080p"); assert.equal(result[0]!.id, "nyaa-123"); assert.ok(result[0]!.datetime);
    });
    check(`${source.id} empty`, () => assert.equal(run('<html></html>').length, 0));
  } else failures.push(`Uncovered source: ${source.id}`);
}
mkdirSync(".genflow_tmp", { recursive: true });
writeFileSync(`.genflow_tmp/transform-${configured ? 'configured' : 'fixtures'}-report.json`, JSON.stringify({ sources: sources.map(s => s.id), passed: count, failures }, null, 2));
console.log(`${sources.length} sources; ${count} passed; ${failures.length} failed`);
for (const failure of failures.slice(0, 15)) console.error(failure);
if (failures.length) process.exitCode = 1;

