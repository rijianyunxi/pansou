import { defineEventHandler, getRouterParam, readBody, setHeader } from "h3";
import { createError } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { updateManagedResource } from "../../../core/services/managedResourceService";
export default defineEventHandler(async (event) => { requireAdminAuth(event); setHeader(event, "Cache-Control", "no-store"); try { const resource = updateManagedResource(String(getRouterParam(event, "id") || ""), await readBody(event)); return { code: 0, message: "updated", data: { resource } }; } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "资源数据不合法" }); } });
