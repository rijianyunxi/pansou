import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { saveSourceTemplateSettings } from "../../core/services/sourceTemplateSettings";
export default defineEventHandler(async (event) => { requireAdminAuth(event); try { return { code: 0, message: "saved", data: saveSourceTemplateSettings(await readBody(event)) }; } catch (error) { throw toHttpError(error, 400, "failed to save source template"); } });
