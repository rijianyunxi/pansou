import test from "node:test";
import assert from "node:assert/strict";

import { parseQuarkShareUrl, isQuarkShareUrl, isQuarkFid, QuarkClient } from "../src/providers/quark.js";
import { parseBaiduShareUrl, isBaiduShareUrl, BaiduClient } from "../src/providers/baidu.js";
import { detectProvider } from "../src/index.js";
import { cookieValue, mergeSetCookies, formatSize } from "../src/lib/util.js";

test("夸克链接解析：pwd_id 与提取码", () => {
  assert.deepEqual(parseQuarkShareUrl("https://pan.quark.cn/s/abc123XY-_"), { pwdId: "abc123XY-_", passcode: "" });
  assert.equal(parseQuarkShareUrl("https://pan.quark.cn/s/abc123?pwd=1234").passcode, "1234");
  assert.equal(parseQuarkShareUrl("https://pan.quark.cn/s/abc123", "9999").passcode, "9999");
  assert.equal(isQuarkShareUrl("https://pan.quark.cn/s/abc"), true);
  assert.equal(isQuarkShareUrl("https://pan.baidu.com/s/1abc"), false);
  assert.throws(() => parseQuarkShareUrl("https://example.com/x"), /格式不正确/);
});

test("夸克 fid 校验：十六进制串必须被接受", () => {
  // 回归用例：这个真实 fid 曾被 /^\d+$/ 误杀，导致"该分享中没有可删除的资源"
  assert.equal(isQuarkFid("4208105bd6034246836d3671829d9349"), true);
  assert.equal(isQuarkFid("123456"), true);
  assert.equal(isQuarkFid("abcDEF123_-"), true);
  assert.equal(isQuarkFid("0"), false);
  assert.equal(isQuarkFid(""), false);
  assert.equal(isQuarkFid(null), false);
  assert.equal(isQuarkFid("has space"), false);
});

test("百度链接解析：surl 与提取码", () => {
  assert.deepEqual(parseBaiduShareUrl("https://pan.baidu.com/s/1abcdEFG"), { surl: "abcdEFG", password: "" });
  assert.equal(parseBaiduShareUrl("https://pan.baidu.com/s/1abcd?pwd=xy12").password, "xy12");
  assert.equal(parseBaiduShareUrl("https://pan.baidu.com/s/1abcd", "zz99").password, "zz99");
  assert.equal(isBaiduShareUrl("https://pan.baidu.com/s/1abc"), true);
  assert.throws(() => parseBaiduShareUrl("not a url"), /格式不正确/);
});

test("自动识别网盘类型", () => {
  assert.equal(detectProvider("https://pan.quark.cn/s/abc"), "quark");
  assert.equal(detectProvider("https://pan.baidu.com/s/1abc"), "baidu");
  assert.throws(() => detectProvider("https://example.com/s/abc"), /无法识别/);
});

test("Cookie 取值与合并", () => {
  const cookie = "BAIDUID=AAA:FG=1; BDUSS=xyz; STOKEN=token123";
  assert.equal(cookieValue(cookie, "BDUSS"), "xyz");
  assert.equal(cookieValue(cookie, "STOKEN"), "token123");
  assert.equal(cookieValue(cookie, "MISSING"), "");

  const response = new Response("", { headers: { "set-cookie": "BDUSS=newvalue; Path=/; HttpOnly" } });
  const merged = mergeSetCookies(cookie, response);
  assert.match(merged, /BDUSS=newvalue/);
  assert.match(merged, /STOKEN=token123/);
});

test("夸克去重比对：名称 + 大小（纯函数，无网络）", () => {
  const client = new QuarkClient({});
  const mine = [
    { fid: "a1", name: "电影A", size: 100, isDir: false },
    { fid: "b2", name: "剧集B", size: 0, isDir: true },
  ];
  const result = client.matchExisting(
    [
      { name: "电影A", size: 100 },
      { name: "剧集B", size: 0 },
      { name: "缺失C", size: 50 },
    ],
    mine,
  );
  assert.equal(result.exists, true);
  assert.equal(result.matched.length, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(result.matched[0].mine.fid, "a1");
  assert.equal(result.missing[0].name, "缺失C");
});

test("百度去重比对：优先 md5，退化到名称 + 大小", () => {
  const client = new BaiduClient({});
  const mine = [{ fsId: "1", name: "别的名字", size: 999, isDir: false, md5: "abc123" }];
  // 名称与大小都不同，但 md5 命中 → 应判为已存在
  const byMd5 = client.matchExisting([{ name: "原名", size: 111, md5: "abc123", isDir: false }], mine);
  assert.equal(byMd5.exists, true);
  assert.equal(byMd5.matched[0].mine.fsId, "1");

  // 无 md5 时退化到 名称 + 大小
  const byKey = client.matchExisting([{ name: "别的名字", size: 999, md5: "", isDir: false }], mine);
  assert.equal(byKey.exists, true);

  // 目录不参与匹配
  const dir = client.matchExisting([{ name: "别的名字", size: 999, isDir: true }], mine);
  assert.equal(dir.exists, false);
});

test("夸克转存任务的新 fid：数量对得上才采用，否则回退列目录", () => {
  const client = new QuarkClient({});
  const task = (fids, extra = {}) => ({ status: 2, save_as: { save_as_top_fids: fids, save_as_sum_num: 19, ...extra } });

  // 正常：1 个顶层条目 → 1 个新 fid
  assert.deepEqual(client.topFidsFromTask(task(["abc123"]), 1), ["abc123"]);
  // 多条目也对得上
  assert.deepEqual(client.topFidsFromTask(task(["a1", "b2"]), 2), ["a1", "b2"]);
  // 嵌在 task_resp 里也认
  assert.deepEqual(client.topFidsFromTask({ task_resp: { data: { save_as: { save_as_top_fids: ["x9"] } } } }, 1), ["x9"]);

  // 数量对不上 → 一律回退（宁可慢一点，也不能分享到错误的文件）
  assert.equal(client.topFidsFromTask(task(["a1"]), 2), null);
  assert.equal(client.topFidsFromTask(task(["a1", "b2"]), 1), null);
  // 字段缺失 / 空 / 非法入参
  assert.equal(client.topFidsFromTask(task([]), 1), null);
  assert.equal(client.topFidsFromTask({ status: 2 }, 1), null);
  assert.equal(client.topFidsFromTask(null, 1), null);
  assert.equal(client.topFidsFromTask(task(["a1"]), 0), null);
  assert.equal(client.topFidsFromTask(task(["a1"]), undefined), null);
  // 有空洞也算对不上（过滤后数量变了）
  assert.equal(client.topFidsFromTask(task(["a1", ""]), 2), null);
});

test("体积格式化", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1024), "1.00 KB");
  assert.equal(formatSize(1536), "1.50 KB");
  assert.equal(formatSize(1024 * 1024), "1.00 MB");
  assert.equal(formatSize(-1), "-");
});
