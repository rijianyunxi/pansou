import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { getPluginSecretStore } from "../../../core/plugins/secretStore";
import { enforceAdminRateLimit } from "../../../utils/adminSecurity";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

const SECRET_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;
const MAX_SECRET_VALUE_LENGTH = 4096;

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  enforceAdminRateLimit(event, "plugin-secrets", { limit: 30, windowMs: 60_000 });
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw createError({
      statusCode: 400,
      statusMessage: "secret name must match [a-zA-Z_][a-zA-Z0-9_]{0,31}",
    });
  }
  if (!value || value.length > MAX_SECRET_VALUE_LENGTH) {
    throw createError({
      statusCode: 400,
      statusMessage: `secret value must be 1 to ${MAX_SECRET_VALUE_LENGTH} characters`,
    });
  }
  const repository = getPluginRepository();
  const record = await repository.get(id);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }
  await getPluginSecretStore().set(id, name, value);
  // Audit records the operation and name only — never the value.
  await repository
    .audit(id, "secret_set", String(body?.actor || "admin").slice(0, 100), { name })
    .catch(() => undefined);
  return { code: 0, message: "secret saved" };
});
