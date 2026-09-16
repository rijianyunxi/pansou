import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSourceTemplateSettings } from "../../core/services/sourceTemplateSettings";
export default defineEventHandler((event) => { requireAdminAuth(event); setResponseHeader(event, "Cache-Control", "private, no-store"); return { code: 0, data: getSourceTemplateSettings() }; });
