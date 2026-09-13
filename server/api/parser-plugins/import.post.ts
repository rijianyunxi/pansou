import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getParserPluginRepository } from "../../core/parsers/repository";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const plugins = Array.isArray(body?.plugins) ? body.plugins : Array.isArray(body) ? body : [];
  if (!plugins.length || plugins.length > 100) throw createError({ statusCode: 400, statusMessage: "plugins must contain 1-100 entries" });
  try {
    const imported = [];
    for (const plugin of plugins) imported.push(await getParserPluginRepository().saveDraft({ manifest: plugin.manifest, code: plugin.code }, String(body?.actor || "admin").slice(0, 100), "Imported parser plugin"));
    return { code: 0, message: "imported", data: imported };
  } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
