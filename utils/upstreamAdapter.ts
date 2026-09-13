import type { AdapterMapping } from "../config/upstreams";
import type { SearchResult } from "../server/core/types/models";

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
  if (/^magnet:\?xt=urn:btih:/i.test(value) || /^ed2k:\/\//i.test(value))
    return true;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export function inferDriveType(url: string, value = ""): string {
  const aliases: Record<string, string> = {
    bdy: "baidu",
    aly: "aliyun",
    "189cloud": "tianyi",
    caiyun: "mobile",
    "123pan": "123",
  };
  const type = value.trim().toLowerCase();
  if (aliases[type]) return aliases[type];
  if (
    [
      "baidu",
      "aliyun",
      "quark",
      "tianyi",
      "uc",
      "mobile",
      "115",
      "123",
      "xunlei",
      "pikpak",
      "magnet",
      "ed2k",
    ].includes(type)
  )
    return type;
  if (/^magnet:/i.test(url)) return "magnet";
  if (/^ed2k:/i.test(url)) return "ed2k";
  const hosts: Record<string, string> = {
    "pan.baidu.com": "baidu",
    "pan.quark.cn": "quark",
    "alipan.com": "aliyun",
    "aliyundrive.com": "aliyun",
    "drive.uc.cn": "uc",
    "cloud.189.cn": "tianyi",
    "115.com": "115",
    "pan.xunlei.com": "xunlei",
  };
  try {
    const host = new URL(url).hostname;
    return (
      Object.entries(hosts).find(
        ([h]) => host === h || host.endsWith(`.${h}`),
      )?.[1] || "others"
    );
  } catch {
    return "others";
  }
}
export function normalizeUpstreamJson(
  payload: unknown,
  mapping: AdapterMapping,
  source: string,
): SearchResult[] {
  const items = readMappingPath(payload, mapping.items);
  if (!Array.isArray(items))
    throw new Error(
      `结果列表「${mapping.items || "根节点"}」不是数组，请检查字段路径。`,
    );
  return items.slice(0, 200).flatMap((item, index) => {
    const rawLinks = mapping.linkArray
      ? readMappingPath(item, mapping.linkArray)
      : [item];
    const links = (Array.isArray(rawLinks) ? rawLinks : []).flatMap((link) => {
      const url = text(readMappingPath(link, mapping.url)).trim();
      if (!validResourceUrl(url)) return [];
      return [
        {
          url,
          type: inferDriveType(
            url,
            mapping.type ? text(readMappingPath(link, mapping.type)) : "",
          ),
          password: mapping.password
            ? text(readMappingPath(link, mapping.password))
            : "",
        },
      ];
    });
    if (!links.length) return [];
    return [
      {
        unique_id: `${source}-${index}`,
        message_id: "",
        channel: source,
        datetime: "",
        title: text(readMappingPath(item, mapping.title))
          .replace(/<[^>]*>/g, "")
          .trim(),
        content: "",
        links,
      },
    ];
  });
}
