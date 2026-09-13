import { createError, defineEventHandler, getRouterParam } from "h3";
import { getParserPluginRepository } from "../../core/parsers/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const data = await getParserPluginRepository().get(id);
  if (!data) throw createError({ statusCode: 404, statusMessage: "parser plugin not found" });
  return { code: 0, message: "success", data };
});
