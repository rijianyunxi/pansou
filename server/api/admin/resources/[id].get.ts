import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { createError } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getManagedResource } from "../../../core/services/managedResourceService";
export default defineEventHandler((event) => { requireAdminAuth(event); setHeader(event, "Cache-Control", "no-store"); const resource = getManagedResource(String(getRouterParam(event, "id") || "")); if (!resource) throw createError({ statusCode: 404, statusMessage: "资源不存在" }); return { code: 0, message: "success", data: { resource } }; });
