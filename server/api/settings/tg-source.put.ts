import { createError, defineEventHandler, readBody, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getTgSourceSettingsVersion, saveTgSourceSettings } from "../../core/services/tgSourceSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  try {
    const data = saveTgSourceSettings(await readBody(event));
    return { code: 0, message: "saved", data, version: getTgSourceSettingsVersion() };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
