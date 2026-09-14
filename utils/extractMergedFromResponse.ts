import type { MergedLink, MergedLinks, SearchResponse } from "~/server/core/types/models";

function responseItems(data: SearchResponse | undefined): unknown[] {
  if (!data) return [];

  // complete 事件默认携带扁平 MergedLink[]；res=results 时为 SearchResult[]。
  // res=all 的链接数组放在 items 中。
  const arr = Array.isArray(data.results) && data.results.length > 0
    ? data.results
    : data.items;
  return Array.isArray(arr) ? arr : [];
}

/** 将 API 响应规范化为保留原始返回顺序的扁平链接列表。 */
export function extractLinksFromResponse(
  data: SearchResponse | undefined
): MergedLink[] {
  const out: MergedLink[] = [];

  for (const raw of responseItems(data)) {
    if (!raw || typeof raw !== "object") continue;
    const rAny = raw as any;
    const links = rAny.links;
    if (Array.isArray(links) && links.length > 0) {
      const note = rAny.title || rAny.content || "";
      const dt = rAny.datetime || "";
      for (const link of links) {
        if (!link?.url) continue;
        const type = String(link.type || "others").toLowerCase();
        out.push({
          type,
          url: link.url,
          password: link.password || "",
          note,
          datetime: dt,
          source:
            rAny.source === "plugin" && rAny.pluginId
              ? `plugin:${rAny.pluginId}@${rAny.pluginVersion || "unknown"}`
              : rAny.channel
                ? `tg:${rAny.channel}`
                : undefined,
          pluginId: rAny.pluginId,
          pluginVersion: rAny.pluginVersion,
          registryVersion: rAny.registryVersion,
          images: rAny.images,
        });
      }
      continue;
    }

    // 扁平 MergedLink：接口直接返回的主要格式。
    if (!rAny.url) continue;
    out.push({
      type: String(rAny.type || "others").toLowerCase(),
      url: rAny.url,
      password: rAny.password || "",
      note: rAny.note || "",
      datetime: rAny.datetime || "",
      source: rAny.source,
      pluginId: rAny.pluginId,
      pluginVersion: rAny.pluginVersion,
      registryVersion: rAny.registryVersion,
      images: rAny.images,
    });
  }

  return out;
}

/** 兼容仍需要按平台索引结果的调用方。 */
export function groupLinksByType(items: MergedLink[]): MergedLinks {
  const out: MergedLinks = {};
  for (const item of items) {
    const type = String(item.type || "others").toLowerCase();
    if (!out[type]) out[type] = [];
    out[type]!.push(item);
  }
  return out;
}

/** 将 API 结果转为前端按平台索引的兼容模型。 */
export function extractMergedFromResponse(
  data: SearchResponse | undefined
): MergedLinks {
  return groupLinksByType(extractLinksFromResponse(data));
}
