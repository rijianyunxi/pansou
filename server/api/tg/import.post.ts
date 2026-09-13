import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings, saveSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { getTgChannelPolicies, saveTgChannelPolicies } from "../../core/services/tgChannelSettings";
import { parseChannelPolicies, parseSystemChannels, telegramSettingsView } from "../../utils/telegramSettings";

/**
 * 批量导入系统 TG 频道配置（频道清单和/或每频道策略）。
 * - channels: null（恢复内置默认）/ 公开用户名数组；缺省表示不修改频道清单。
 * - policies: null（清空策略）/ 以频道用户名为键的策略对象；缺省表示不修改策略。
 * 校验先行：任一字段非法即 400，不落任何一半配置。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  const body = await readBody(event);
  const hasChannels = !!body && typeof body === "object" && "channels" in body;
  const hasPolicies = !!body && typeof body === "object" && "policies" in body;
  if (!hasChannels && !hasPolicies) {
    throw createError({ statusCode: 400, statusMessage: "import payload must contain channels and/or policies" });
  }
  const channels = hasChannels ? parseSystemChannels(body.channels) : undefined;
  const policies = hasPolicies ? parseChannelPolicies(body.policies) : undefined;
  try {
    if (channels !== undefined) saveSearchSettings({ channels });
    if (policies !== undefined) saveTgChannelPolicies(policies);
  } catch {
    throw createError({ statusCode: 500, statusMessage: "导入失败，现有配置未改变，请检查服务端存储权限。" });
  }
  const saved = getSearchSettings();
  return {
    code: 0,
    data: telegramSettingsView(
      saved.channels,
      getSystemSettings(useRuntimeConfig()).defaultChannels,
      getTgChannelPolicies(),
    ),
  };
});
