#!/usr/bin/env node
/**
 * /api/search (SSE) 压测脚本 —— 零依赖，Node >= 18。
 *
 * 针对本项目的三种关键词模式：
 *   hot    同一个热门词反复搜索，命中 Redis 缓存路径，测缓存命中性能；
 *   random 关键词池随机取词，走本地索引/DB 与上游实况搜索路径，测缓存未命中性能；
 *   mixed  hot/random 交替，模拟真实流量混合比例。
 *
 * 会话：默认每个虚拟用户单独申请一个匿名会话（/api/account/session），
 * 会话级限流（匿名 20 次/分钟每会话）被分摊；注意 IP 级限流（匿名 60 次/分钟每 IP）
 * 由所有虚拟用户共享，超过即返回 429——这是系统的预期防护行为，报告里会单列统计。
 * 如有已登录 token 可用 --token 传入（登录档 60 次/分钟每会话、240 次/分钟每 IP）。
 *
 * 用法示例：
 *   node scripts/stress-search.mjs --base https://pan.letus.lol \
 *     --stages "1:60:1500,8:15:0,3:120:4000" --mode mixed --csv stress.csv
 *   阶段格式：并发数:持续秒数:每次请求后思考毫秒数，逗号分隔依次执行。
 *
 *   # 只测缓存命中基线
 *   node scripts/stress-search.mjs --stages "1:60:1500" --mode hot
 *   # 在服务器本机压测真实容量（先临时调高限流，且绕过反代）
 *   node scripts/stress-search.mjs --base http://127.0.0.1:8080 --token <token> --stages "8:300:0"
 */
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// ---------- 参数 ----------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const BASE = (arg("base", "https://pan.letus.lol").replace(/\/+$/, ""));
const API = `${BASE}/api/search`;
const SESSION_API = `${BASE}/api/account/session`;
const STAGES = String(arg("stages", "1:60:1500")).split(",").map((s) => {
  const [vus, seconds, think] = s.split(":");
  return { vus: +vus, seconds: +seconds, think: +(think ?? 0) };
});
const MODE = arg("mode", "mixed"); // hot | random | mixed | realistic
const UNIQUE_RATIO = parseFloat(arg("unique-ratio", "0.8")); // realistic 模式下不重复词占比
const KW_FILE = arg("keywords-file", ""); // 每行一个词；realistic 模式按顺序消费，不重复
const REPEAT_POOL = String(arg("repeat-pool", "壁纸,电影,电视剧,音乐,小说")).split(",").map((s) => s.trim()).filter(Boolean);
const HOT_KW = arg("hotkw", "壁纸");
const KEYWORDS = String(arg("keywords", "电影,电视剧,音乐,动漫,纪录片,演唱会,教程,软件,小说,考研,字幕,4K,蓝光,Unity,Python,健身,菜谱,摄影,剪辑,游记"))
  .split(",").map((s) => s.trim()).filter(Boolean);
const TOKEN = arg("token", ""); // 已登录会话 token（可选）
const TIMEOUT_MS = +arg("timeout", 40000); // 单请求超时（服务端搜索超时默认 30s）
const CSV = arg("csv", "");
const QUIET = args.includes("--quiet");
const LABEL = arg("label", new Date().toISOString().replace("T", " ").slice(0, 19));

let stopped = false;
process.on("SIGINT", () => { stopped = true; console.error("\n收到中断，结束当前阶段后汇总…"); });

// ---------- 工具 ----------
const pct = (sorted, p) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
};
const ms = (v) => (Number.isFinite(v) ? `${(v / 1000).toFixed(3)}s` : "-");

class Stats {
  constructor(name) { this.name = name; this.samples = []; }
  add(s) { this.samples.push(s); }
  // 按结束时间分桶到秒，供 CSV 输出
  perSecond() {
    const buckets = new Map();
    for (const s of this.samples) {
      const sec = Math.floor(s.end / 1000);
      const b = buckets.get(sec) ?? { sent: 0, ok: 0, rateLimited: 0, failed: 0 };
      b.sent++; if (s.ok) b.ok++; else if (s.kind === "rate_limited") b.rateLimited++; else if (!s.ok) b.failed++;
      buckets.set(sec, b);
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  }
  summary(durationMs) {
    const all = this.samples;
    const ok = all.filter((s) => s.ok);
    const byKind = {};
    for (const s of all) if (!s.ok) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    const lat = ok.map((s) => s.total).sort((a, b) => a - b);
    const ttfb = ok.map((s) => s.ttfb).sort((a, b) => a - b);
    const results = ok.map((s) => s.results);
    return {
      name: this.name, requests: all.length, ok: ok.length,
      rps: ok.length / (durationMs / 1000),
      errors: byKind,
      errorRate: all.length ? (all.length - ok.length) / all.length : 0,
      lat: { p50: pct(lat, 50), p90: pct(lat, 90), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.at(-1), avg: lat.reduce((a, b) => a + b, 0) / (lat.length || 1) },
      ttfb: { p50: pct(ttfb, 50), p95: pct(ttfb, 95), max: ttfb.at(-1) },
      bytes: all.reduce((a, s) => a + s.bytes, 0),
      resultsAvg: results.reduce((a, b) => a + b, 0) / (results.length || 1),
    };
  }
}

const fmtStage = (s, durationMs) => {
  const e = (s.errors && Object.keys(s.errors).length) ? Object.entries(s.errors).map(([k, v]) => `${k}=${v}`).join(" ") : "-";
  return [
    s.name.padEnd(22),
    `请求 ${String(s.requests).padStart(5)}`,
    `成功 ${String(s.ok).padStart(5)}`,
    `吞吐 ${s.rps.toFixed(2)}/s`,
    `错误率 ${(s.errorRate * 100).toFixed(1)}%`,
    `失败明细 ${e}`,
    `完成延迟 P50 ${ms(s.lat.p50)} P90 ${ms(s.lat.p90)} P95 ${ms(s.lat.p95)} P99 ${ms(s.lat.p99)} avg ${ms(s.lat.avg)} max ${ms(s.lat.max)}`,
    `TTFB P50 ${ms(s.ttfb.p50)} P95 ${ms(s.ttfb.p95)}`,
    `平均结果 ${s.resultsAvg.toFixed(1)} 条`,
  ].join("  ");
};

let uniqueCursor = 0, uniqueUsed = 0, repeatUsed = 0;
let uniquePool = [];
if (KW_FILE) {
  uniquePool = fs.readFileSync(KW_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
}

function pickKeyword(seq) {
  if (MODE === "realistic") {
    let kw;
    if (Math.random() < UNIQUE_RATIO && uniquePool.length) {
      kw = uniqueCursor < uniquePool.length ? uniquePool[uniqueCursor++] : uniquePool[Math.floor(Math.random() * uniquePool.length)];
      uniqueUsed++;
    } else {
      kw = REPEAT_POOL[Math.floor(Math.random() * REPEAT_POOL.length)];
      repeatUsed++;
    }
    return kw;
  }
  if (MODE === "hot") return HOT_KW;
  if (MODE === "random") return KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  return seq % 2 === 0 ? HOT_KW : KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)]; // mixed
}

// ---------- 会话 ----------
async function acquireToken() {
  if (TOKEN) return TOKEN;
  const res = await fetch(SESSION_API, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`申请匿名会话失败 HTTP ${res.status}`);
  const body = await res.json();
  if (!body.sessionId) throw new Error("会话响应缺少 sessionId");
  return body.sessionId;
}

// ---------- 单次搜索（SSE） ----------
async function searchOnce(token, kw) {
  const sample = { start: Date.now(), ttfb: NaN, total: NaN, ok: false, kind: "", status: 0, bytes: 0, results: 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("client timeout")), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ kw }),
      signal: ac.signal,
    });
    sample.ttfb = Date.now() - sample.start;
    sample.status = res.status;
    if (res.status === 429) { // 限流：固定窗口计数超限，属预期防护
      sample.kind = "rate_limited"; sample.bytes = (await res.text()).length;
      return sample;
    }
    if (!res.ok) {
      sample.kind = `http_${res.status}`; sample.bytes = (await res.text()).length;
      return sample;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const text = await res.text(); sample.bytes = text.length;
      sample.kind = "unexpected_content_type"; return sample;
    }
    // 流式解析 SSE：start → result* → complete
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", completed = false, errored = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sample.bytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const event = /event: (.+)/.exec(frame)?.[1];
        const data = /data: (.+)/.exec(frame)?.[1];
        if (event === "result") {
          try { sample.results += (JSON.parse(data).results ?? []).length; } catch { /* 忽略坏帧 */ }
        } else if (event === "complete") completed = true;
        else if (event === "error") errored = data ?? "error";
      }
    }
    sample.total = Date.now() - sample.start;
    if (completed) { sample.ok = true; }
    else if (errored) { sample.kind = `sse_error:${errored.slice(0, 60)}`; }
    else { sample.kind = "truncated"; } // 流提前结束，未收到 complete
  } catch (e) {
    sample.total = Date.now() - sample.start;
    sample.kind = e?.message === "client timeout" ? "timeout" : `network:${String(e?.cause?.code ?? e?.message ?? e).slice(0, 60)}`;
  } finally {
    clearTimeout(timer);
    sample.end = Date.now();
  }
  return sample;
}

// ---------- 阶段执行 ----------
async function runStage({ vus, seconds, think }, index) {
  const name = `#${index + 1} 并发${vus}/${seconds}s/think${think}ms/${MODE}`;
  console.log(`\n▶ 阶段${name}`);
  const tokens = await Promise.all(Array.from({ length: vus }, acquireToken));
  const stats = new Stats(name);
  const deadline = Date.now() + seconds * 1000;
  let seq = 0;
  const workers = tokens.map(async (token) => {
    let mySeq;
    while (!stopped && Date.now() < deadline) {
      mySeq = seq++;
      const s = await searchOnce(token, pickKeyword(mySeq));
      stats.add(s);
      const mark = s.ok ? "✓" : s.kind === "rate_limited" ? "Ⅹ" : "✗";
      if (!QUIET) process.stdout.write(`${mark}${s.ok ? ms(s.total) : s.kind.slice(0, 40)} `);
      else if (s.ok === false && s.kind !== "rate_limited") process.stdout.write(`\n${mark}${s.kind.slice(0, 60)} `);
      if (think) await sleep(think);
    }
  });
  const started = Date.now();
  await Promise.all(workers);
  const summary = stats.summary(Date.now() - started);
  if (CSV) {
    const rows = stats.perSecond().map(([sec, b]) => `${sec},${index + 1},${b.sent},${b.ok},${b.rateLimited},${b.failed}`);
    fs.appendFileSync(CSV, rows.join("\n") + (rows.length ? "\n" : ""));
  }
  return summary;
}

// ---------- 主流程 ----------
console.log(`压测目标  ${API}`);
console.log(`模式 ${MODE}${MODE === "realistic" ? `（不重复比例目标 ${(UNIQUE_RATIO * 100).toFixed(0)}%，唯一词池 ${uniquePool.length} 个，重复词池 [${REPEAT_POOL.join(",")}]）` : `（热词"${HOT_KW}"，词池 ${KEYWORDS.length} 个）`}  单请求超时 ${TIMEOUT_MS}ms  ${TOKEN ? "已登录 token（登录档限流）" : "匿名会话（每虚拟用户独立会话）"}`);
if (CSV) fs.writeFileSync(CSV, `unix_sec,stage,sent,ok,rate_limited,failed\n`);
const summaries = [];
for (let i = 0; i < STAGES.length && !stopped; i++) {
  const summary = await runStage(STAGES[i], i);
  summaries.push(summary);
  console.log(`\n  ${fmtStage(summary)}`);
}
console.log(`\n===== 汇总（${LABEL}）=====`);
for (const s of summaries) console.log(fmtStage(s));
if (MODE === "realistic") {
  const total = uniqueUsed + repeatUsed;
  console.log(`\n搜索词分布：不重复 ${uniqueUsed} / 重复 ${repeatUsed} = 实际不重复比例 ${total ? ((uniqueUsed / total) * 100).toFixed(1) : "-"}%（目标 ${(UNIQUE_RATIO * 100).toFixed(0)}%），唯一词池消费 ${uniqueCursor}/${uniquePool.length}`);
}
console.log(`\n说明：错误率里 rate_limited 是限流器按设计拒绝的请求，不算服务故障；`);
console.log(`timeout/truncated/http_5xx 才是容量问题的信号。缓存命中(hot)与未命中(random)要分开对比。`);
