import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { toHttpError } from "../../../../utils/apiResponse";
import { purgeUnifiedSource } from "../../../../core/services/sourceCatalog";

function normalizeSourceId(value: unknown): string {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

/** Permanently remove an archived resource source. */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const sourceId = normalizeSourceId(getRouterParam(event, "id"));
  const body = await readBody(event).catch(() => ({}));
  if (!sourceId || normalizeSourceId(body?.confirmation) !== sourceId) {
    throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match source id" });
  }

  try {
    return { code: 0, message: "purged", data: purgeUnifiedSource(sourceId) };
  } catch (error) {
    throw toHttpError(error, 409, "failed to permanently delete source");
  }
});
