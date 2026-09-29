/**
 * 统一入口：把"校验 / 转存 / 去重 / 分享 / 删除"串成可直接调用的工作流。
 *
 * 支持夸克（quark）与百度（baidu）两个网盘。
 */
import { WangpanError } from "./lib/util.js";
import { QuarkClient, isQuarkShareUrl } from "./providers/quark.js";
import { BaiduClient, isBaiduShareUrl } from "./providers/baidu.js";

export { WangpanError };
export { QuarkClient, isQuarkShareUrl } from "./providers/quark.js";
export { BaiduClient, isBaiduShareUrl } from "./providers/baidu.js";

/** 从链接自动判断网盘类型。 */
export function detectProvider(url) {
  if (isQuarkShareUrl(url)) return "quark";
  if (isBaiduShareUrl(url)) return "baidu";
  throw new WangpanError("无法识别网盘类型，目前仅支持夸克（pan.quark.cn）与百度（pan.baidu.com）分享链接");
}

/** 创建指定网盘的客户端。 */
export function createClient(provider, options = {}) {
  if (provider === "quark") return new QuarkClient(options);
  if (provider === "baidu") return new BaiduClient(options);
  throw new WangpanError(`不支持的网盘类型：${provider}`);
}

function resolve(provider, url) {
  return provider || detectProvider(url);
}

/**
 * 能力 1：判断给定链接是否有效。
 * @returns {Promise<{provider:string, valid:boolean, reason?:string, title?:string, fileCount:number, files:Array}>}
 */
export async function checkLink(url, { provider = null, password = null } = {}) {
  const target = resolve(provider, url);
  const client = createClient(target);
  const result = await client.validateShare(url, password);
  return { provider: target, ...result, timings: client.trace };
}

/**
 * 能力 2：把链接资源转存到自己的网盘。
 * @param {object} options
 * @param {string} [options.toDir] 百度：目标目录路径（默认 "/"）；夸克：目标目录 fid（默认 "0"）
 * @param {boolean} [options.autoShare] 转存成功后，为自己网盘里刚保存的内容生成分享链接并一并返回
 * @returns {Promise<{provider:string, saved:boolean, count:number, target:string, names:string[], share:object|null}>}
 */
export async function saveLink(url, { provider = null, password = null, toDir = null, autoShare = false } = {}) {
  const target = resolve(provider, url);
  const client = createClient(target);
  if (target === "quark") {
    const toPdirFid = toDir || "0";
    const result = await client.saveShare(url, password, { toPdirFid, autoShare });
    return { provider: target, ...result, count: result.files, target: toPdirFid, timings: client.trace };
  }
  const targetDir = toDir || "/";
  const result = await client.saveShare(url, password, { toDir: targetDir, autoShare });
  return { provider: target, ...result, target: targetDir, timings: client.trace };
}

/**
 * 能力 3：检测资源是否已存在于自己网盘；若已存在，直接为自己已有的资源创建分享。
 *
 * 返回结构：
 *  - alreadyExists=true  → 命中已有资源，existing 为命中项，share 为"已有资源的新分享链接"
 *  - alreadyExists=false → 未命中，可继续调用 saveLink 转存
 *
 * @returns {Promise<{provider:string, alreadyExists:boolean, matched:Array, missing:Array, share?:object}>}
 */
export async function checkExistingAndShare(url, { provider = null, password = null, dir = null, autoShare = true } = {}) {
  const target = resolve(provider, url);
  const client = createClient(target);
  const scanDir = dir ?? (target === "quark" ? "0" : "/");

  // 列目录与解析分享互不依赖，并行执行可省一个网络来回
  const [meta, mine] = await Promise.all([client.validateShare(url, password), client.listDir(scanDir)]);
  if (!meta.valid) throw new WangpanError(meta.reason || "分享链接无效", { provider: target });

  const { exists, matched, missing } = client.matchExisting(meta.files, mine);

  if (!exists || !autoShare) {
    return { provider: target, alreadyExists: exists, matched, missing, share: null, timings: client.trace };
  }

  const ids = matched
    .map((pair) => (target === "quark" ? pair.mine.fid : pair.mine.fsId))
    .filter((id) => id);
  if (!ids.length) {
    return { provider: target, alreadyExists: exists, matched, missing, share: null, timings: client.trace };
  }

  const share = await client.createShare(ids, {});
  return { provider: target, alreadyExists: true, matched, missing, share, timings: client.trace };
}

/**
 * 按"我自己的分享链接"删除我网盘里的资源。
 * @returns {Promise<{provider:string, deleted:number, timings:Array}>}
 */
export async function deleteMyShare(url, { provider = null, password = null } = {}) {
  const target = resolve(provider, url);
  const client = createClient(target);
  const result = await client.deleteByShareUrl(url, password);
  return { provider: target, ...result, timings: client.trace };
}

/** 校验当前 Cookie 是否可用。 */
export async function ping(provider, options = {}) {
  const client = createClient(provider, options);
  return client.ping();
}
