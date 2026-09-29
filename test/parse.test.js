import test from "node:test";
import assert from "node:assert/strict";

import { parseQuarkShareUrl, isQuarkShareUrl } from "../src/providers/quark.js";
import { parseBaiduShareUrl, isBaiduShareUrl } from "../src/providers/baidu.js";
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

test("体积格式化", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1024), "1.00 KB");
  assert.equal(formatSize(1536), "1.50 KB");
  assert.equal(formatSize(1024 * 1024), "1.00 MB");
  assert.equal(formatSize(-1), "-");
});
