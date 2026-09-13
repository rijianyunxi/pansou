import { createError, defineEventHandler, getRouterParam } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { getPluginSecretStore } from "../../../core/plugins/secretStore";
import { enforceAdminRateLimit } from "../../../utils/adminSecurity";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** Lists only the declared secret names; values never leave the store. */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  enforceAdminRateLimit(event, "plugin-secrets", { limit: 30, windowMs: 60_000 });
  const id = getRouterParam(event, "id") || "";
  const record = await getPluginRepository().get(id);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }
  const names = await getPluginSecretStore().list(id);
  return { code: 0, message: "success", data: { names } };
});
