import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getPluginRepository } from "../../../core/plugins/repository";
import { updateResponseAdapter } from "../../../utils/responseAdapter";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const repository = getPluginRepository();
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  const record = await repository.get(id);
  if (!record) throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  if (record.status === "archived") throw createError({ statusCode: 409, statusMessage: "请先恢复已删除的上游。" });
  if (body?.baseVersion !== record.definition.manifest.version) throw createError({ statusCode: 409, statusMessage: "草稿版本已更新，请刷新后重新编辑。" });
  try {
    const definition = updateResponseAdapter(record.definition, body?.response);
    return { code: 0, data: await repository.saveDraft(definition, "admin-console", "Update response adapter") };
  } catch (reason) {
    throw createError({ statusCode: 400, statusMessage: reason instanceof Error ? reason.message : "Invalid response adapter" });
  }
});
