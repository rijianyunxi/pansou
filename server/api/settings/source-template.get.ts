import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSourceTemplateSettings } from "../../core/services/sourceTemplateSettings";
export default defineEventHandler((event) => { requireAdminAuth(event); return { code: 0, data: getSourceTemplateSettings() }; });
