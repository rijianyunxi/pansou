import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getParserPluginRepository } from "../../core/parsers/repository";
import { setTgChannelParser, setUpstreamParser } from "../../core/services/tgChannelSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const scope = body?.scope === "telegram" || body?.scope === "upstream" ? body.scope : "";
  const id = String(body?.id || "").trim();
  const pluginId = body?.pluginId ? String(body.pluginId).trim() : null;
  if (!scope || !id) throw createError({ statusCode: 400, statusMessage: "scope and id are required" });
  if (pluginId) {
    const plugin = await getParserPluginRepository().get(pluginId);
    if (!plugin || plugin.status !== "published") throw createError({ statusCode: 400, statusMessage: "parser plugin must be published before binding" });
    if (plugin.manifest.target !== "both" && plugin.manifest.target !== scope) throw createError({ statusCode: 400, statusMessage: "parser plugin target does not match binding scope" });
  }
  try {
    const binding = scope === "telegram" ? setTgChannelParser(id, pluginId) : setUpstreamParser(id, pluginId);
    return { code: 0, message: "saved", data: { scope, id, binding } };
  } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
