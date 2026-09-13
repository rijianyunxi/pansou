import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getSearchSettings } from "../../../../core/services/searchSettingsService";
import { getSystemSettings } from "../../../../core/services/systemSettingsService";
import { countEffectiveTgChannels, setTgChannelState } from "../../../../core/services/tgChannelSettings";
import { normalizeTgChannelParam, tgChannelOrigin } from "../../../../utils/telegramSettings";
import { TG_CHANNEL_PATTERN } from "../../../../../utils/telegramChannels";

/**
 * POST /api/tg/channels/:channel/disable —— 停用单个 TG 频道（覆盖状态）。
 * 生效清单由搜索侧按覆盖状态过滤，下一次搜索立即生效。
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
  let enabled: boolean;
  let deleted: boolean;
  try {
    const entry = setTgChannelState(channel, { enabled: false });
    enabled = entry.enabled;
    deleted = entry.deleted;
  } catch {
    return { code: -1, message: "无法保存频道状态，请检查服务端存储权限。" };
  }
  const settings = getSearchSettings();
  const config = useRuntimeConfig();
  const system = getSystemSettings(config);
  return {
    code: 0,
    message: "disabled",
    data: {
      channel,
      enabled,
      deleted,
      origin: tgChannelOrigin(channel, settings.channels, system.defaultChannels),
      effectiveCount: countEffectiveTgChannels(settings.channels ?? (system.defaultChannels)),
    },
  };
});
