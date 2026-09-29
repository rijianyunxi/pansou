#!/usr/bin/env node
/**
 * 批量回归：把一批分享链接依次转存一遍，统计 save 各阶段耗时。
 *
 * 用法：
 *   node scripts/regress-save.mjs links.txt
 *   node scripts/regress-save.mjs https://pan.quark.cn/s/aaa https://pan.quark.cn/s/bbb
 *   node scripts/regress-save.mjs links.txt --delete       # 存完再删掉，方便反复跑
 *   node scripts/regress-save.mjs links.txt --no-dedup     # 关掉去重（对齐界面不勾选的情况）
 *   node scripts/regress-save.mjs links.txt --json out.json
 *   node scripts/regress-save.mjs links.txt --quiet        # 只留结果表，关掉上游诊断日志
 *
 * links.txt：每行一个链接；空行与 # 开头的行忽略；可选「链接 提取码」，用空格或制表符分隔。
 *
 * 统计口径与界面一致：**以「接口往返」为准**（各步累计在并行步骤上会重复计算）。
 * 表格里额外拆出「等任务」= 等待任务 + 轮询等待，用来观察夸克侧执行时间占比。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { saveLink, deleteMyShare, warm } from "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { inputs: [], dedup: true, cleanup: false, json: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--delete") options.cleanup = true;
    else if (arg === "--no-dedup") options.dedup = false;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--json") options.json = argv[(i += 1)];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.inputs.push(arg);
  }
  return options;
}

async function loadLinks(inputs) {
  const links = [];
  for (const input of inputs) {
    if (/^https?:\/\//iu.test(input)) {
      links.push({ url: input, password: "" });
      continue;
    }
    const text = await fs.readFile(path.resolve(ROOT, input), "utf8");
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [url, password = ""] = line.split(/\s+/u);
      links.push({ url, password });
    }
  }
  return links;
}

const ms = (value) => `${Math.round(value)}ms`;

function sumSteps(timings, steps) {
  const wanted = new Set(steps);
  return timings.filter((item) => wanted.has(item.step)).reduce((total, item) => total + item.ms, 0);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function printBreakdown(label, timings) {
  const grouped = new Map();
  for (const item of timings) grouped.set(item.step, (grouped.get(item.step) || 0) + item.ms);
  const parts = [...grouped.entries()].map(([step, value]) => `${step}=${ms(value)}`);
  console.log(`      ${label}：${parts.join(" ")}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.inputs.length) {
    console.log(
      [
        "用法：node scripts/regress-save.mjs <links.txt | 链接...> [--delete] [--no-dedup] [--json out.json] [--quiet]",
        "",
        "links.txt 每行一个链接，可选在链接后用空格跟一个提取码。",
      ].join("\n"),
    );
    return;
  }

  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    /* 无 .env 时靠已有环境变量 */
  }
  if (options.quiet) process.env.WANGPAN_LOG = "0";

  const links = await loadLinks(options.inputs);
  if (!links.length) {
    console.error("没有解析到任何链接");
    process.exitCode = 1;
    return;
  }

  console.log(`共 ${links.length} 个链接｜去重=${options.dedup ? "开" : "关"}｜存完清理=${options.cleanup ? "是" : "否"}`);
  const warmed = await warm(null);
  console.log(`连接已预热：${warmed.origins.join("、")}\n`);

  const rows = [];
  for (const [index, { url, password }] of links.entries()) {
    const ordinal = String(index + 1).padStart(2, " ");
    const startedAt = Date.now();
    let result = null;
    let error = null;
    try {
      result = await saveLink(url, { password: password || null, dedup: options.dedup, autoShare: true });
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - startedAt;
    const timings = result?.timings ?? error?.timings ?? [];

    if (error) {
      rows.push({ url, elapsed, ok: false, error: error.message, timings });
      console.log(`[${ordinal}] ✗ ${ms(elapsed)}  ${error.message}`);
      printBreakdown("各步", timings);
      continue;
    }

    const taskMs = sumSteps(timings, ["等待任务", "轮询等待"]);
    const names = result.names || [];
    const shareUrl = result.share?.url || "";
    rows.push({
      url,
      elapsed,
      ok: true,
      mode: result.mode,
      files: result.files ?? result.count ?? 0,
      taskMs,
      shareUrl,
      timings,
    });
    console.log(
      `[${ordinal}] ✓ ${ms(elapsed)}｜等任务 ${ms(taskMs)}（${Math.round((taskMs / elapsed) * 100)}%）` +
        `｜顶层 ${names.length} 项｜${names.slice(0, 2).join("、")}${names.length > 2 ? "…" : ""}`,
    );
    printBreakdown("各步", timings);
    if (shareUrl) console.log(`      分享：${shareUrl}`);

    if (options.cleanup && shareUrl) {
      try {
        const removed = await deleteMyShare(shareUrl);
        console.log(`      已清理：删除 ${removed.deleted} 项`);
        rows.at(-1).cleaned = removed.deleted;
      } catch (caught) {
        console.log(`      清理失败：${caught.message}`);
        rows.at(-1).cleanupError = caught.message;
      }
    }
  }

  const ok = rows.filter((row) => row.ok);
  const times = ok.map((row) => row.elapsed);
  const taskTimes = ok.map((row) => row.taskMs);

  console.log(`\n${"─".repeat(64)}`);
  console.log(`成功 ${ok.length}/${rows.length}｜接口往返（不含清理）`);
  if (ok.length) {
    const totalTask = taskTimes.reduce((a, b) => a + b, 0);
    const totalAll = times.reduce((a, b) => a + b, 0);
    console.log(
      `  最快 ${ms(Math.min(...times))}｜中位 ${ms(percentile(times, 0.5))}｜` +
        `平均 ${ms(totalAll / times.length)}｜最慢 ${ms(Math.max(...times))}`,
    );
    console.log(
      `  等任务合计占比 ${Math.round((totalTask / totalAll) * 100)}%` +
        `（最快 ${ms(Math.min(...taskTimes))} / 最慢 ${ms(Math.max(...taskTimes))}）`,
    );
    const slowest = ok.reduce((worst, row) => (row.elapsed > worst.elapsed ? row : worst), ok[0]);
    console.log(`\n最慢的一次：${ms(slowest.elapsed)}  ${slowest.url}`);
    printBreakdown("各步", slowest.timings);
  }

  if (options.json) {
    const target = path.resolve(ROOT, options.json);
    await fs.writeFile(target, `${JSON.stringify({ at: new Date().toISOString(), options: { dedup: options.dedup }, rows }, null, 2)}\n`);
    console.log(`\n明细已写入 ${target}`);
  }
}

await main();
