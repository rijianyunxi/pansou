import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { createManagedResource } from "../../core/services/managedResourceService";
export default defineEventHandler(async (event) => { requireAdminAuth(event); setHeader(event, "Cache-Control", "no-store"); try { return { code: 0, message: "created", data: { resource: createManagedResource(await readBody(event)) } }; } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "资源数据不合法" }); } });
