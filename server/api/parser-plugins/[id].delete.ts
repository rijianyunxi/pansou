import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../core/parsers/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getParserPluginBindingReferences } from "../../core/services/tgChannelSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  if (String(body?.confirmation || "") !== id) throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match plugin id" });
  const bindings = getParserPluginBindingReferences(id);
  if (bindings.length) {
    const targets = bindings.map((binding) => binding.scope === "telegram" ? `Telegram @${binding.id}` : `来源 ${binding.id}`).join("、");
    throw createError({ statusCode: 400, statusMessage: `解析器已绑定到 ${targets}，解除绑定后才能删除` });
  }
  try { await getParserPluginRepository().purge(id); return { code: 0, message: "purged" }; }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
