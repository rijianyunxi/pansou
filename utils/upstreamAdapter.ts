import type { CloudType } from "../server/core/types/models";

/** Deliberately restricted dot paths; never evaluates expressions or follows prototypes. */
export function readMappingPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      return undefined;
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    )
      return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
export function validResourceUrl(value: string): boolean {
  if (/^magnet:\?/i.test(value) || /^ed2k:\/\//i.test(value))
    return true;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export type { CloudType } from "../server/core/types/models";

const CLOUD_TYPE_ALIASES: Record<string, CloudType> = {
  baidu: "baidu",
  bdy: "baidu",
  "百度": "baidu",
  quark: "quark",
  "夸克": "quark",
  aliyun: "aliyun",
  aly: "aliyun",
  alipan: "aliyun",
  "阿里": "aliyun",
  "阿里云盘": "aliyun",
  mobile: "mobile",
  caiyun: "mobile",
  "139": "mobile",
  "中国移动云盘": "mobile",
  tianyi: "tianyi",
  "189cloud": "tianyi",
  "189": "tianyi",
  "天翼": "tianyi",
  "天翼云盘": "tianyi",
  "115": "115",
  "115网盘": "115",
  "123": "123",
  "123pan": "123",
  "123云盘": "123",
  jianguoyun: "jianguoyun",
  "坚果云": "jianguoyun",
  lanzou: "lanzou",
  xunlei: "xunlei",
  thunder: "xunlei",
  "迅雷": "xunlei",
  "迅雷盘": "xunlei",
  lanzoux: "lanzou",
  lanzoui: "lanzou",
  lanzous: "lanzou",
  "蓝奏云": "lanzou",
  others: "others",
  other: "others",
  "其他": "others",
};

const CLOUD_HOSTS: Array<[string, CloudType]> = [
  ["pan.xunlei.com", "xunlei"],
  ["pan.baidu.com", "baidu"],
  ["pan.quark.cn", "quark"],
  ["aliyundrive.com", "aliyun"],
  ["alipan.com", "aliyun"],
  ["yun.139.com", "mobile"],
  ["cloud.189.cn", "tianyi"],
  ["115.com", "115"],
  ["123pan.com", "123"],
  ["123pan.cn", "123"],
  ["123684.com", "123"],
  ["123865.com", "123"],
  ["jianguoyun.com", "jianguoyun"],
  ["lanzou.com", "lanzou"],
  ["lanzoux.com", "lanzou"],
  ["lanzoui.com", "lanzou"],
  ["lanzous.com", "lanzou"],
  ["lanzouq.com", "lanzou"],
  ["lanzouj.com", "lanzou"],
  ["lanzouo.com", "lanzou"],
  ["lanzout.com", "lanzou"],
];

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function normalizeCloudType(value: unknown): CloudType | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CLOUD_TYPE_ALIASES[normalized];
}

/**
 * Determines the canonical cloud type exclusively from the resource URL. A
 * source-provided label cannot manufacture a cloud type for an unknown host.
 */
export function inferDriveType(url: string, _value = ""): CloudType {
  if (/^magnet:/i.test(url)) return "magnet";
  if (/^ed2k:\/\//i.test(url)) return "others";

  try {
    const host = new URL(url).hostname.toLowerCase();
    const match = CLOUD_HOSTS.find(([domain]) => isDomain(host, domain));
    if (match) return match[1];
    // 蓝奏分享 links rotate through lanzou.com/lanzoux.com/lanzoui.com
    // and similar resolver domains; keep the whole family on one canonical type.
    if (/(^|\.)lanzou[a-z0-9-]*\.com$/.test(host)) return "lanzou";
  } catch {
    // Invalid or non-HTTP resource URLs are kept under others.
  }

  return "others";
}
