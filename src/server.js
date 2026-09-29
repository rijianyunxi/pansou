#!/usr/bin/env node
/**
 * 本地 Web 服务：为网盘工具提供图形界面。
 *
 * 启动：node src/server.js   （默认 http://127.0.0.1:8787）
 *
 * 安全说明：
 *  - 只监听 127.0.0.1，不对外暴露。
 *  - Cookie 默认从环境变量/.env 读取；也可在界面里临时填写，仅保存在进程内存中，
 *    不写入磁盘，重启即失效。
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkLink, saveLink, checkExistingAndShare, deleteMyShare, createClient, detectProvider } from "./index.js";
import { WangpanError } from "./lib/util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const HOST = process.env.WANGPAN_HOST || "127.0.0.1";
const PORT = Number(process.env.WANGPAN_PORT || 8787);

// 进程内存中的 Cookie（覆盖 .env，不落盘）
const memoryCookies = { quark: "", baidu: "" };

function loadEnvFile() {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    /* 无 .env 时忽略 */
  }
}

function cookieFor(provider, override) {
  if (override) return String(override).trim();
  if (memoryCookies[provider]) return memoryCookies[provider];
  return String(process.env[provider === "quark" ? "QUARK_COOKIE" : "BAIDU_COOKIE"] || "").trim();
}

function clientFor(provider, override) {
  return createClient(provider, { cookie: cookieFor(provider, override) });
}

/** 登录态信息：是否已配置、长度、来源（memory=界面填写 / env=.env / none=未配置）。 */
function cookieInfo(provider) {
  const envKey = provider === "quark" ? "QUARK_COOKIE" : "BAIDU_COOKIE";
  const value = cookieFor(provider);
  if (!value) return { configured: false, length: 0, source: "none" };
  return { configured: true, length: value.length, source: memoryCookies[provider] ? "memory" : process.env[envKey] ? "env" : "none" };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new WangpanError("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WangpanError("请求体不是合法 JSON");
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function serveStatic(response, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/u, "");
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, { "content-type": MIME[path.extname(target)] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
  }
}

/** 解析 provider：显式指定优先，否则从链接自动识别。 */
function resolveProvider(provider, url) {
  if (provider) return provider;
  if (url) return detectProvider(url);
  return "quark";
}

const routes = {
  "GET /api/config": () => ({
    quark: cookieInfo("quark"),
    baidu: cookieInfo("baidu"),
  }),

  // 只在填写了非空值时才覆盖；留空 = 不修改（与界面提示一致）
  "POST /api/config": (body) => {
    if (typeof body.quark === "string" && body.quark.trim()) memoryCookies.quark = body.quark.trim();
    if (typeof body.baidu === "string" && body.baidu.trim()) memoryCookies.baidu = body.baidu.trim();
    return { quark: cookieInfo("quark"), baidu: cookieInfo("baidu") };
  },

  // 清除界面填写的覆盖值（若来源是 .env，清除后仍会回落到 .env）
  "POST /api/config/clear": (body) => {
    const provider = body.provider;
    if (provider !== "quark" && provider !== "baidu") throw new WangpanError("provider 必须是 quark 或 baidu");
    memoryCookies[provider] = "";
    return { quark: cookieInfo("quark"), baidu: cookieInfo("baidu") };
  },

  "POST /api/check": async (body) => {
    const provider = resolveProvider(body.provider, body.url);
    const result = await checkLink(body.url, { provider, password: body.password ?? null });
    return { provider, ...result };
  },

  "POST /api/save": async (body) => {
    const provider = resolveProvider(body.provider, body.url);
    const toDir = body.toDir || null;
    // 默认转存成功后生成"我自己的分享链接"并随响应返回；传 autoShare:false 可关闭
    const autoShare = body.autoShare !== false;
    const options = { provider, password: body.password ?? null, toDir, autoShare };

    // 勾选去重：先查我网盘是否已有 → 有则复用已有资源建分享；没有则照常转存
    if (body.dedup) {
      const dup = await checkExistingAndShare(body.url, { provider, password: options.password, dir: toDir, autoShare });
      if (dup.alreadyExists) return { provider, mode: "reused", ...dup };
      const saved = await saveLink(body.url, options);
      return { provider, mode: "saved", dedup: { matched: [], missing: dup.missing }, ...saved };
    }
    const saved = await saveLink(body.url, options);
    return { provider, mode: "saved", ...saved };
  },

  "POST /api/delete": async (body) => {
    const provider = resolveProvider(body.provider, body.url);
    const result = await deleteMyShare(body.url, { provider, password: body.password ?? null });
    return { provider, ...result };
  },

  "POST /api/mine": async (body) => {
    const provider = resolveProvider(body.provider, null);
    const dir = body.dir || (provider === "quark" ? "0" : "/");
    const files = await clientFor(provider, body.cookie).listDir(dir);
    return { provider, dir, files };
  },

  "POST /api/ping": async (body) => {
    const provider = resolveProvider(body.provider, null);
    const result = await clientFor(provider, body.cookie).ping();
    return { provider, ...result };
  },
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const key = `${request.method} ${url.pathname}`;

  if (!routes[key]) {
    if (request.method === "GET") return serveStatic(response, url.pathname);
    return sendJson(response, 404, { ok: false, error: `未知接口 ${key}` });
  }

  try {
    const body = request.method === "POST" ? await readBody(request) : {};
    const data = await routes[key](body);
    sendJson(response, 200, { ok: true, data });
  } catch (error) {
    const message = error instanceof WangpanError ? error.message : error?.message || String(error);
    sendJson(response, 400, { ok: false, error: message, provider: error?.provider || null });
  }
});

loadEnvFile();
server.listen(PORT, HOST, () => {
  console.log(`网盘工具箱已启动：http://${HOST}:${PORT}`);
  console.log(`夸克 Cookie：${cookieFor("quark") ? "已配置" : "未配置"}　百度 Cookie：${cookieFor("baidu") ? "已配置" : "未配置"}`);
});
