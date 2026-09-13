import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getTgSourceSettings, getTgSourceSettingsVersion } from "../../core/services/tgSourceSettings";
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  return { code: 0, data: getTgSourceSettings(), version: getTgSourceSettingsVersion() };
});
