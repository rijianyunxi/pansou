import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveSourceTemplateSettings } from "../../core/services/sourceTemplateSettings";
export default defineEventHandler(async (event) => { requireAdminAuth(event); try { return { code: 0, message: "saved", data: saveSourceTemplateSettings(await readBody(event)) }; } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); } });
