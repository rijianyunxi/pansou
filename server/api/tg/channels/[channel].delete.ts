import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getSearchSettings, saveSearchSettings } from "../../../core/services/searchSettingsService";
import { getSystemSettings } from "../../../core/services/systemSettingsService";
import {
  clearTgChannelState,
  countEffectiveTgChannels,
  setTgChannelState,
} from "../../../core/services/tgChannelSettings";
import { normalizeTgChannelParam, tgChannelOrigin } from "../../../utils/telegramSettings";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../../utils/telegramChannels";

/**
 * DELETE /api/tg/channels/:channel —— 删除 TG 频道（对齐上游插件删除体验）。
 * - 自定义频道（searchSettings.channels）：从清单移除，并清除其覆盖状态；
 * - 内置默认频道：置 deleted=true 覆盖（可用 enable 恢复）；
 * - 不在两个清单中的频道：404。
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
  const settings = getSearchSettings();
  const config = useRuntimeConfig();
  const system = getSystemSettings(config);
  const customChannels = settings.channels;
  const builtinDefaults = normalizeTelegramChannels(system.defaultChannels);

  if (customChannels && customChannels.includes(channel)) {
    try {
      saveSearchSettings({ channels: customChannels.filter((name) => name !== channel) });
      clearTgChannelState(channel);
    } catch {
      return { code: -1, message: "无法保存频道配置，现有配置未改变，请检查服务端存储权限。" };
    }
    const saved = getSearchSettings();
    return {
      code: 0,
      message: "deleted",
      data: {
        channel,
        enabled: true,
        deleted: false,
        origin: tgChannelOrigin(channel, saved.channels, builtinDefaults),
        effectiveCount: countEffectiveTgChannels(saved.channels ?? builtinDefaults),
      },
    };
  }

  if (builtinDefaults.includes(channel)) {
    let enabled: boolean;
    try {
      const entry = setTgChannelState(channel, { deleted: true });
      enabled = entry.enabled;
    } catch {
      return { code: -1, message: "无法保存频道状态，请检查服务端存储权限。" };
    }
    return {
      code: 0,
      message: "deleted",
      data: {
        channel,
        enabled,
        deleted: true,
        origin: "builtin",
        effectiveCount: countEffectiveTgChannels(customChannels ?? builtinDefaults),
      },
    };
  }

  throw createError({ statusCode: 404, statusMessage: "channel not found" });
});
