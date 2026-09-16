import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";
import { telegramSettingsView } from "../../utils/telegramSettings";
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  return {
    code: 0,
    data: telegramSettingsView(
      getSearchSettings().channels,
      getSystemSettings(useRuntimeConfig()).defaultChannels,
    ),
  };
});
