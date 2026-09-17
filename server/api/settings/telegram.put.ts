import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { parseSystemChannels, telegramSettingsView } from "../../utils/telegramSettings";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由
 * （连 nuxt.config.ts 的 routeRules 都没有对应条目）。
 * 与同目录的 telegram.get.ts 是一对；两者都无人使用。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const channels = parseSystemChannels(body?.channels);
  try {
    const saved = saveSearchSettings({ channels });
    return {
      code: 0,
      data: telegramSettingsView(
        saved.channels,
        getSystemSettings(useRuntimeConfig()).defaultChannels,
      ),
    };
  } catch {
    throw createError({ statusCode: 500, statusMessage: "无法保存频道配置，现有配置未改变，请检查服务端存储权限。" });
  }
});
