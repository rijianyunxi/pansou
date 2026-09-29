/**
 * 统一入口：把"校验 / 转存 / 去重 / 分享 / 删除"串成可直接调用的工作流。
 *
 * 支持夸克（quark）与百度（baidu）两个网盘。
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { WangpanError, warmConnections } from "./lib/util.js";
import { QuarkClient, isQuarkShareUrl, quarkBases } from "./providers/quark.js";
import { BaiduClient, isBaiduShareUrl, baiduBases } from "./providers/baidu.js";

export { WangpanError };
export { QuarkClient, isQuarkShareUrl } from "./providers/quark.js";
export { BaiduClient, isBaiduShareUrl } from "./providers/baidu.js";

/** 从链接自动判断网盘类型。 */
export function detectProvider(url) {
  if (isQuarkShareUrl(url)) return "quark";
  if (isBaiduShareUrl(url)) return "baidu";
  throw new WangpanError("无法识别网盘类型，目前仅支持夸克（pan.quark.cn）与百度（pan.baidu.com）分享链接");
}

/**
 * 请求作用域：收集本次请求创建过的客户端。
 *
 * 成功路径由各工作流自己把 `timings` 放进返回值；失败路径没有返回值，
 * 就靠这里把已发生的上游耗时一并带出去——不然报错时完全看不出卡在哪一步。
 * 用 AsyncLocalStorage 而不是模块级变量，是为了在并发请求下也不会串。
 */
const scope = new AsyncLocalStorage();

/** 创建指定网盘的客户端。 */
export function createClient(provider, options = {}) {
  const client = provider === "quark" ? new QuarkClient(options) : provider === "baidu" ? new BaiduClient(options) : null;
  if (!client) throw new WangpanError(`不支持的网盘类型：${provider}`);
  scope.getStore()?.push(client);
  return client;
}

/**
 * 在请求作用域内执行一段工作流。
 * @returns {Promise<{data?:any, error?:Error, timings:Array}>}
 */
export async function runScoped(run) {
  const clients = [];
  try {
    return { data: await scope.run(clients, run), timings: clients.flatMap((client) => client.trace) };
  } catch (error) {
    return { error, timings: clients.flatMap((client) => client.trace) };
  }
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
  // context 是给 saveLink 复用的内部句柄（含原始上游 payload），不对外返回
  const { context, ...visible } = result;
  return { provider: target, ...visible, timings: client.trace };
}

/**
 * 能力 2：把链接资源转存到自己的网盘。
 *
 * @param {object} options
 * @param {string} [options.toDir] 百度：目标目录路径（默认 "/"）；夸克：目标目录 fid（默认 "0"）
 * @param {boolean} [options.autoShare] 转存成功后，为自己网盘里刚保存的内容生成分享链接并一并返回
 * @param {boolean} [options.dedup] 转存前先查自己网盘是否已有该资源；有则直接复用已有资源建分享
 * @returns {Promise<{provider:string, mode:"saved"|"reused", count:number, target:string, names:string[], share:object|null}>}
 */
export async function saveLink(url, { provider = null, password = null, toDir = null, autoShare = false, dedup = false } = {}) {
  const target = resolve(provider, url);
  const client = createClient(target);
  const dir = toDir ?? (target === "quark" ? "0" : "/");
  const saveOptions = target === "quark" ? { toPdirFid: dir, autoShare } : { toDir: dir, autoShare };

  if (!dedup) {
    const result = await client.saveShare(url, password, saveOptions);
    return { provider: target, mode: "saved", ...result, count: result.files ?? result.count, target: dir, timings: client.trace };
  }

  // 去重模式：解析分享与列我的目录互不依赖，并行执行可省一个网络来回
  const [meta, mine] = await Promise.all([client.validateShare(url, password), client.listDir(dir)]);
  if (!meta.valid) throw new WangpanError(meta.reason || "分享链接无效", { provider: target });

  const { exists, matched, missing } = client.matchExisting(meta.files, mine);
  const ids = matched.map((pair) => (target === "quark" ? pair.mine.fid : pair.mine.fsId)).filter((id) => id);

  if (exists && autoShare && ids.length) {
    const share = await client.createShare(ids, {});
    return { provider: target, mode: "reused", alreadyExists: true, matched, missing, share, count: 0, timings: client.trace };
  }
  if (exists) {
    return { provider: target, mode: "reused", alreadyExists: true, matched, missing, share: null, count: 0, timings: client.trace };
  }

  // 未命中 → 复用刚才已经解析好的 context 转存，省掉重复解析分享的那几个网络来回
  const result = await client.saveShare(url, password, { ...saveOptions, shareContext: meta.context });
  return {
    provider: target,
    mode: "saved",
    ...result,
    count: result.files ?? result.count,
    target: dir,
    matched,
    missing,
    timings: client.trace,
  };
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

/**
 * 预热到上游的连接。
 *
 * 一次转存会跨多个域名（夸克：drive.quark.cn + drive-pc.quark.cn），
 * 每个域名的首次请求都要付一次 TCP+TLS 握手。界面加载时先握好，用户点操作时就是热连接。
 */
export async function warm(provider = null) {
  const bases = [];
  if (!provider || provider === "quark") bases.push(...quarkBases());
  if (!provider || provider === "baidu") bases.push(...baiduBases());
  const origins = await warmConnections(bases);
  return { origins };
}
