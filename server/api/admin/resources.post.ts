import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { createManagedResource } from "../../core/services/managedResourceService";
export default defineEventHandler(async (event) => { requireAdminAuth(event); try { return { code: 0, message: "created", data: { resource: createManagedResource(await readBody(event)) } }; } catch (error) { throw toHttpError(error, 400, "资源数据不合法"); } });
