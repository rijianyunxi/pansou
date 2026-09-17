import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { deleteManagedResources } from "../../../core/services/managedResourceService";
export default defineEventHandler((event) => { requireAdminAuth(event); const id = String(getRouterParam(event, "id") || ""); if (!id) throw createError({ statusCode: 400, statusMessage: "资源 ID 不能为空" }); if (!deleteManagedResources([id])) throw createError({ statusCode: 404, statusMessage: "资源不存在" }); return { code: 0, message: "deleted" }; });
