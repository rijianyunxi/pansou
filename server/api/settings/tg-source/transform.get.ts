import { defineEventHandler, setHeader, setResponseHeader } from "h3";
import { getTgSourceSettings, getTgSourceSettingsVersion } from "../../../core/services/tgSourceSettings";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** Export the active Telegram transform as a directly importable JS file. */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  setHeader(event, "Content-Type", "application/javascript; charset=utf-8");
  setHeader(event, "Content-Disposition", 'attachment; filename="telegram-transform.js"');
  setHeader(event, "X-Panhub-Config-Version", getTgSourceSettingsVersion());
  return getTgSourceSettings().transform;
});
