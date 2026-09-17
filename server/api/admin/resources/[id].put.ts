import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { updateManagedResource } from "../../../core/services/managedResourceService";
export default defineEventHandler(async (event) => { requireAdminAuth(event); try { const resource = updateManagedResource(String(getRouterParam(event, "id") || ""), await readBody(event)); return { code: 0, message: "updated", data: { resource } }; } catch (error) { throw toHttpError(error, 400, "资源数据不合法"); } });
