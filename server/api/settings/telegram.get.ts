import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { telegramSettingsView } from "../../utils/telegramSettings";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由
 * （连 nuxt.config.ts 的 routeRules 都没有对应条目）。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return {
    code: 0,
    data: telegramSettingsView(
      getSearchSettings().channels,
      getSystemSettings(useRuntimeConfig()).defaultChannels,
    ),
  };
});
