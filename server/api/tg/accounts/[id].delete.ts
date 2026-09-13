import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getTgAccountStore } from "../../../core/telegram/accountStore";
export default defineEventHandler(async (event) => { requireAdminAuth(event); const id = getRouterParam(event, "id") || ""; const body = await readBody(event).catch(() => ({})); if (String(body?.confirmation || "") !== id) throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match account id" }); try { getTgAccountStore().delete(id); return { code: 0, message: "deleted" }; } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); } });
