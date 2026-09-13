import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { getTgChannelPolicies, saveTgChannelPolicies } from "../../core/services/tgChannelSettings";
import { parseChannelPolicies, parseSystemChannels, telegramSettingsView } from "../../utils/telegramSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  const body = await readBody(event);
  const channels = parseSystemChannels(body?.channels);
  // policies 缺省（undefined）= 保持现有策略不变；null = 清空；对象 = 整包替换
  const policies = body?.policies === undefined ? undefined : parseChannelPolicies(body.policies);
  try {
    const saved = saveSearchSettings({ channels });
    if (policies !== undefined) saveTgChannelPolicies(policies);
    return {
      code: 0,
      data: telegramSettingsView(
        saved.channels,
        getSystemSettings(useRuntimeConfig()).defaultChannels,
        getTgChannelPolicies(),
      ),
    };
  } catch {
    throw createError({ statusCode: 500, statusMessage: "无法保存频道配置，现有配置未改变，请检查服务端存储权限。" });
  }
});
