import { createError, defineEventHandler, getHeader, readBody, readRawBody, setResponseHeader } from "h3";
import { getTgSourceSettingsVersion, saveTgTransform } from "../../../core/services/tgSourceSettings";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** Import a JS file or JSON { transform } and publish it immediately. */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  try {
    const contentType = getHeader(event, "content-type") || "";
    const body = contentType.includes("application/json")
      ? await readBody(event)
      : await readRawBody(event, "utf8");
    const transform = typeof body === "string" ? body : body?.transform;
    const data = saveTgTransform(transform);
    return { code: 0, message: "saved", data, version: getTgSourceSettingsVersion() };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
