import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getTgAccountStore } from "../../../../core/telegram/accountStore";
export default defineEventHandler((event) => { requireAdminAuth(event); try { return { code: 0, data: getTgAccountStore().updateEnabled(getRouterParam(event, "id") || "", true) }; } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); } });
