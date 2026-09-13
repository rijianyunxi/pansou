import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../../core/parsers/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getParserPluginBindingReferences } from "../../../core/services/tgChannelSettings";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  const bindings = getParserPluginBindingReferences(id);
  if (bindings.length) {
    const targets = bindings.map((binding) => binding.scope === "telegram" ? `TG @${binding.id}` : `上游 ${binding.id}`).join("、");
    throw createError({ statusCode: 400, statusMessage: `解析插件已绑定到 ${targets}，解除绑定后才能删除` });
  }
  try { return { code: 0, message: "archive", data: await getParserPluginRepository().archive(id, String(body?.actor || "admin").slice(0, 100)) }; }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
