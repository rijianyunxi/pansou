import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getManagedResource } from "../../../core/services/managedResourceService";
import { deleteCloudResource, type CloudProvider } from "../../../core/services/cloudResourceService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody<{ resourceId?: unknown; linkIndex?: unknown }>(event);
  if (typeof body?.resourceId !== "string" || !body.resourceId.trim()) throw createError({ statusCode: 400, statusMessage: "resourceId 不合法" });
  const linkIndex = Number(body.linkIndex);
  if (!Number.isInteger(linkIndex) || linkIndex < 0) throw createError({ statusCode: 400, statusMessage: "linkIndex 不合法" });
  const resource = getManagedResource(body.resourceId);
  if (!resource) throw createError({ statusCode: 404, statusMessage: "资源不存在" });
  const link = resource.links[linkIndex];
  if (!link || (link.type !== "quark" && link.type !== "baidu")) throw createError({ statusCode: 400, statusMessage: "当前链接不是百度或夸克分享链接" });
  try {
    const result = await deleteCloudResource({ provider: link.type as CloudProvider, url: link.url, password: link.password });
    return { code: 0, message: "deleted", data: { provider: link.type, deletedCount: result.deletedCount } };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "云端资源删除失败" });
  }
});
