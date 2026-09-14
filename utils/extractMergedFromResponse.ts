import type { MergedLinks, SearchResponse } from "~/server/core/types/models";

/** 将扁平 API 结果或 SearchResult[] 转为前端按平台分组的展示模型。 */
export function extractMergedFromResponse(
  data: SearchResponse | undefined
): MergedLinks {
  if (!data) return {};

  // complete 事件默认携带扁平 MergedLink[]；res=results 时为 SearchResult[]。
  // res=all 的链接数组放在 items 中。
  const arr = Array.isArray(data.results) && data.results.length > 0
    ? data.results
    : data.items;
  if (!Array.isArray(arr) || arr.length === 0) return {};

  const out: MergedLinks = {};
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const rAny = raw as any;
    const links = rAny.links;
    if (Array.isArray(links) && links.length > 0) {
      const note = rAny.title || rAny.content || "";
      const dt = rAny.datetime || "";
      for (const link of links) {
        if (!link?.url) continue;
        const type = String(link.type || "others").toLowerCase();
        if (!out[type]) out[type] = [];
        out[type].push({
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
    const type = String(rAny.type || "others").toLowerCase();
    if (!out[type]) out[type] = [];
    out[type].push({
      type,
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
