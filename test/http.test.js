/**
 * HTTP 层测试：全部跑在本机临时 server 上，不依赖外网。
 *
 * 重点验证三件事：
 *  1. 自建连接池确实复用了 TCP 连接（原生 fetch 的 undici 保活只有 4 秒，
 *     空闲稍久就重新握手，这是之前接口"有点慢"的主因）。
 *  2. 超时覆盖「读响应体」阶段，而不是只覆盖到拿到响应头。
 *  3. HeaderBag 与 mergeSetCookies 兼容（百度靠它刷新 STOKEN）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { httpRequest, closeAgents, mergeSetCookies, cookieValue } from "../src/lib/util.js";

/** 起一个本地 server，返回 { origin, connections(), close() }。 */
async function startServer(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 30_000;
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    connections: () => connections,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("连接池：连续多次请求复用同一条 TCP 连接", async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "STOKEN=refreshed; Path=/" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  try {
    const first = await httpRequest(`${server.origin}/a`);
    assert.equal(first.ok, true);
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body), { ok: true, path: "/a" });
    assert.ok(first.ms >= 0, "应返回耗时");

    // 中间故意等 5 秒——超过 undici 的 4 秒保活窗口，旧实现这里必然重新握手
    await new Promise((resolve) => setTimeout(resolve, 5000));

    for (let i = 0; i < 3; i += 1) {
      const response = await httpRequest(`${server.origin}/b${i}`);
      assert.equal(response.status, 200);
    }

    assert.equal(server.connections(), 1, "4 次请求（含 5 秒空闲）应只建立 1 条连接");

    // HeaderBag 要能被 mergeSetCookies 正确消费
    const merged = mergeSetCookies("BDUSS=abc; BAIDUID=def", first.headers);
    assert.equal(cookieValue(merged, "STOKEN"), "refreshed");
    assert.equal(cookieValue(merged, "BDUSS"), "abc");
    assert.deepEqual(first.headers.getSetCookie(), ["STOKEN=refreshed; Path=/"]);
  } finally {
    await server.close();
  }
});

test("超时：响应头返回后 body 一直不结束，也会被强制中断", async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("开始但不结束"); // 故意不 end()
  });
  const previous = process.env.WANGPAN_TIMEOUT_MS;
  process.env.WANGPAN_TIMEOUT_MS = "600";
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => httpRequest(`${server.origin}/hang`),
      (error) => {
        assert.match(error.message, /请求超时/);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `应在超时窗口附近返回，实际 ${elapsed}ms`);
  } finally {
    if (previous === undefined) delete process.env.WANGPAN_TIMEOUT_MS;
    else process.env.WANGPAN_TIMEOUT_MS = previous;
    await server.close();
  }
});

test("错误语义：HTTP 4xx 不抛异常，交给上层按业务码判断", async () => {
  const server = await startServer((request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ errno: -6 }));
  });
  try {
    const response = await httpRequest(`${server.origin}/forbidden`);
    assert.equal(response.ok, false);
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { errno: -6 });
  } finally {
    await server.close();
  }
});

test("非法 URL 立即报错，不会挂起", async () => {
  await assert.rejects(() => httpRequest("not-a-url"), /URL 不合法/);
});

test.after(() => closeAgents());
