import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../../core/parsers/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  try { return { code: 0, message: "enable", data: await getParserPluginRepository().enable(id, String(body?.actor || "admin").slice(0, 100)) }; }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
