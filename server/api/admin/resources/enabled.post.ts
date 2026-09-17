import { createError, defineEventHandler, readBody } from "h3";
import { setManagedResourcesEnabled } from "../../../core/services/managedResourceService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/**
 * Take a resource offline without deleting it.
 *
 * A hard delete throws away the id, the links and the creation time, so a
 * resource whose share links went stale had to be rebuilt from scratch. Search
 * only returns enabled rows; the console lists both states.
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ ids?: unknown; enabled?: unknown }>(event);
  if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "ids 必须是字符串数组" });
  }
  if (typeof body?.enabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "enabled 必须是布尔值" });
  }
  return {
    code: 0,
    message: body.enabled ? "enabled" : "disabled",
    data: { count: setManagedResourcesEnabled(body.ids, body.enabled) },
  };
});
