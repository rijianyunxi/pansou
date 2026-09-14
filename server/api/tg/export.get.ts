import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { getTgChannelPolicies } from "../../core/services/tgChannelSettings";
import { telegramSettingsView } from "../../utils/telegramSettings";

/**
 * 批量导出系统 Telegram 频道配置（频道清单 + 每频道策略）。
 * data 字段可直接作为 /api/tg/import 的请求体回导。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  const saved = getSearchSettings();
  return {
    code: 0,
    data: {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...telegramSettingsView(
        saved.channels,
        getSystemSettings(useRuntimeConfig()).defaultChannels,
        getTgChannelPolicies(),
      ),
    },
  };
});
