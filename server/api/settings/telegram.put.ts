import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { parseSystemChannels, telegramSettingsView } from "../../utils/telegramSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
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
