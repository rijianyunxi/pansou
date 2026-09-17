import { createError, defineEventHandler, readBody } from "h3";
import { deleteManagedResources } from "../../../core/services/managedResourceService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
export default defineEventHandler(async (event) => { requireAdminAuth(event); const body = await readBody<{ ids?: unknown }>(event); if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== "string")) throw createError({ statusCode: 400, statusMessage: "ids 必须是字符串数组" }); return { code: 0, message: "deleted", data: { count: deleteManagedResources(body.ids) } }; });

