#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 用法：
 *   node src/cli.js check  <分享链接> [--pwd 提取码] [--provider quark|baidu]
 *   node src/cli.js save   <分享链接> [--pwd 提取码] [--to 目标目录] [--dedup]
 *   node src/cli.js mine   [--provider quark|baidu] [--dir 目录]
 *   node src/cli.js delete <我的分享链接> [--pwd 提取码] [--yes]
 *   node src/cli.js ping   [--provider quark|baidu]
 *
 * 通用参数：--json 输出原始 JSON；--provider 覆盖自动识别。
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkLink, saveLink, checkExistingAndShare, deleteMyShare, ping, detectProvider } from "./index.js";
import { formatSize, WangpanError } from "./lib/util.js";

loadEnv();

function loadEnv() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* .env 不存在时忽略，直接使用进程环境变量 */
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function printFileList(files) {
  if (!files.length) {
    console.log("  (空)");
    return;
  }
  for (const file of files) {
    const kind = file.isDir ? "[目录]" : "[文件]";
    const size = file.isDir ? "-" : formatSize(file.size);
    console.log(`  ${kind} ${file.name}  ${size}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positionals } = parseArgs(rest);
const asJson = Boolean(flags.json);
const provider = typeof flags.provider === "string" ? flags.provider : null;
const password = typeof flags.pwd === "string" ? flags.pwd : null;

function fail(error) {
  const message = error instanceof WangpanError ? error.message : error?.message || String(error);
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`\n✗ ${message}`);
  process.exitCode = 1;
}

async function main() {
  switch (command) {
    case "check": {
      const url = positionals[0];
      if (!url) throw new WangpanError("缺少分享链接参数");
      const result = await checkLink(url, { provider, password });
      if (asJson) return console.log(JSON.stringify(result, null, 2));
      console.log(`\n网盘：${result.provider}`);
      console.log(`状态：${result.valid ? "✓ 有效" : "✗ 无效"}`);
      if (!result.valid) return console.log(`原因：${result.reason}`);
      if (result.title) console.log(`标题：${result.title}`);
      console.log(`文件数：${result.fileCount}`);
      printFileList(result.files);
      return;
    }

    case "save": {
      const url = positionals[0];
      if (!url) throw new WangpanError("缺少分享链接参数");
      const target = typeof flags.to === "string" ? flags.to : null;

      if (flags.dedup) {
        const dup = await checkExistingAndShare(url, { provider, password, dir: target });
        if (asJson) return console.log(JSON.stringify(dup, null, 2));
        if (dup.alreadyExists) {
          console.log(`\n✓ 已存在于你的网盘，直接复用已有资源：`);
          for (const pair of dup.matched) console.log(`  ${pair.mine.name}（${formatSize(pair.mine.size)}）`);
          if (dup.share) console.log(`\n分享链接：${dup.share.url}${dup.share.password ? `  提取码：${dup.share.password}` : ""}`);
          return;
        }
        console.log("\n未在网盘中发现同名资源，开始转存…");
      }

      const result = await saveLink(url, { provider, password, toDir: target });
      if (asJson) return console.log(JSON.stringify(result, null, 2));
      console.log(`\n✓ 转存成功：${result.count} 个文件 → ${result.target}`);
      return;
    }

    case "mine": {
      const target = provider || "quark";
      const dir = typeof flags.dir === "string" ? flags.dir : target === "quark" ? "0" : "/";
      const client = (await import("./index.js")).createClient(target);
      const files = await client.listDir(dir);
      if (asJson) return console.log(JSON.stringify(files, null, 2));
      console.log(`\n${target} 网盘目录 ${dir}（${files.length} 项）：`);
      printFileList(files);
      return;
    }

    case "delete": {
      const url = positionals[0];
      if (!url) throw new WangpanError("缺少我的分享链接参数");
      if (!flags.yes) {
        console.log("这是删除操作，请加 --yes 确认执行：");
        console.log(`  node src/cli.js delete "${url}" --yes`);
        return;
      }
      const result = await deleteMyShare(url, { provider, password });
      if (asJson) return console.log(JSON.stringify(result, null, 2));
      console.log(`\n✓ 已从你的网盘删除 ${result.deleted} 个资源`);
      return;
    }

    case "ping": {
      const target = provider || "quark";
      const result = await ping(target);
      if (asJson) return console.log(JSON.stringify({ provider: target, ...result }, null, 2));
      console.log(`\n✓ ${target} Cookie 可用，根目录 ${result.count} 项`);
      return;
    }

    default:
      console.log(`用法：
  node src/cli.js check  <分享链接> [--pwd 提取码] [--provider quark|baidu]
  node src/cli.js save   <分享链接> [--pwd 提取码] [--to 目标目录] [--dedup]
  node src/cli.js mine   [--provider quark|baidu] [--dir 目录]
  node src/cli.js delete <我的分享链接> [--pwd 提取码] [--yes]
  node src/cli.js ping   [--provider quark|baidu]

示例：
  node src/cli.js check "https://pan.quark.cn/s/abcdef123456"
  node src/cli.js save  "https://pan.baidu.com/s/1abcdef?pwd=abcd" --dedup
  node src/cli.js delete "https://pan.quark.cn/s/myshare" --yes

Cookie 通过环境变量提供（见 .env.example）：
  QUARK_COOKIE=...  BAIDU_COOKIE=...`);
  }
}

main().catch(fail);

export { detectProvider };
