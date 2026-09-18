import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { channelSettingsView } from "../../utils/channelSettings";

/**
 * 频道配置视图：把「账号自定义频道」（`search_settings.channels`）与管理员默认频道
 * （`system_channels`）放在一起返回，供后台的默认频道编辑页使用。
 *
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由
 * （连 nuxt.config.ts 的 routeRules 都没有对应条目）。路由原名 `/api/settings/telegram`，
 * 与它实际返回的内容不符，2026-09-18 一并改名。保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return {
    code: 0,
    data: channelSettingsView(
      getSearchSettings().channels,
      getSystemSettings(useRuntimeConfig()).defaultChannels,
    ),
  };
});
