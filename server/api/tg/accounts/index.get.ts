import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { getTgAccountStore } from "../../../core/telegram/accountStore";
export default defineEventHandler((event) => { requireAdminAuth(event); setResponseHeader(event, "Cache-Control", "private, no-store"); return { code: 0, data: getTgAccountStore().list() }; });
