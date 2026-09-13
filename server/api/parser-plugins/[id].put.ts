import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../core/parsers/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  const plugin = body?.plugin || { manifest: { ...(body?.manifest || {}), id }, code: body?.code };
  if (plugin.manifest?.id !== id) throw createError({ statusCode: 400, statusMessage: "manifest.id must match route id" });
  try { return { code: 0, message: "draft_saved", data: await getParserPluginRepository().saveDraft(plugin, String(body?.actor || "admin").slice(0, 100), body?.changelog) }; }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
