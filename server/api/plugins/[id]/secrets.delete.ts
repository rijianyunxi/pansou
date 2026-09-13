import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { getPluginSecretStore } from "../../../core/plugins/secretStore";
import { enforceAdminRateLimit } from "../../../utils/adminSecurity";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  enforceAdminRateLimit(event, "plugin-secrets", { limit: 30, windowMs: 60_000 });
  const id = getRouterParam(event, "id") || "";
  const query = getQuery(event);
  const name = typeof query.name === "string" ? query.name.trim() : "";
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: "name is required" });
  }
  const repository = getPluginRepository();
  const record = await repository.get(id);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }
  await getPluginSecretStore().delete(id, name);
  await repository
    .audit(id, "secret_deleted", String(query.actor || "admin").slice(0, 100), { name })
    .catch(() => undefined);
  return { code: 0, message: "secret deleted" };
});
