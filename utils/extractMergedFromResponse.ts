import type { MergedLinks, SearchResponse } from "~/server/core/types/models";

/** 将扁平 API 结果或 SearchResult[] 转为前端按平台分组的展示模型。 */
export function extractMergedFromResponse(
  data: SearchResponse | Record<string, any> | undefined
): MergedLinks {
  if (!data) return {};

  const record = data as Record<string, any>;

  // 兼容旧版响应：按平台分组的 merged_by_type 仍可由历史接口返回。
  const mergedByType = record.merged_by_type;
  if (mergedByType && typeof mergedByType === "object" && !Array.isArray(mergedByType)) {
    const keys = Object.keys(mergedByType);
    if (keys.length > 0) return mergedByType as MergedLinks;
  }

  // 默认 /api/search 返回扁平的 MergedLink[]，每条记录自带 type/source。
  // res=results 时仍可能返回 SearchResult[]，这里将其展开为相同的前端分组模型。
  const arr = Array.isArray(data)
    ? data
    : (Array.isArray(record.results) && record.results.length > 0
      ? record.results
      : (record.items ?? record.list ?? record.data));
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
