import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** POST /api/plugins/:id/enable —— 恢复停用的插件（与 disable 对称），下一次搜索重新参与调度。 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  try {
    return {
      code: 0,
      message: "enabled",
      data: await getPluginRepository().enable(
        id,
        String(body?.actor || "admin").slice(0, 100)
      ),
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
