import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getSearchSettings, saveSearchSettings } from "../../../../core/services/searchSettingsService";
import { getSystemSettings } from "../../../../core/services/systemSettingsService";
import { clearTgChannelState, countEffectiveTgChannels } from "../../../../core/services/tgChannelSettings";
import { normalizeTgChannelParam, tgChannelOrigin } from "../../../../utils/telegramSettings";
import { TG_CHANNEL_PATTERN } from "../../../../../utils/telegramChannels";

/**
 * POST /api/tg/channels/:channel/enable —— 开启（恢复）单个 Telegram 频道。
 * 清除 enabled=false 与 deleted=true 覆盖（"开启 = 恢复"），下一次搜索立即生效。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  const channel = normalizeTgChannelParam(getRouterParam(event, "channel"));
  if (!TG_CHANNEL_PATTERN.test(channel)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Channel must be a public Telegram username (5-64 chars: A-Za-z0-9_)",
    });
  }
  try {
    clearTgChannelState(channel);
  } catch {
    return { code: -1, message: "无法保存频道状态，请检查服务端存储权限。" };
  }
  let settings = getSearchSettings();
  // In explicit-source mode, a source toggle must update the search scope as
  // well as the runtime state. In all-sources mode (null), the state table is
  // the single source of truth and no explicit list is written.
  if (settings.channels !== null) {
    const channels = new Set(settings.channels);
    channels.add(channel);
    saveSearchSettings({ channels: [...channels] });
    settings = getSearchSettings();
  }
  const config = useRuntimeConfig();
  const system = getSystemSettings(config);
  return {
    code: 0,
    message: "enabled",
    data: {
      channel,
      enabled: true,
      deleted: false,
      origin: tgChannelOrigin(channel, settings.channels, system.defaultChannels),
      effectiveCount: countEffectiveTgChannels(settings.channels ?? (system.defaultChannels)),
    },
  };
});
