import { createError, type H3Event } from "h3";
import { requireAdminAuth } from "./requireAdminAuth";

/** Run an in-process GramJS action behind the PanHub admin session. */
export async function withTelegramMtproto<T>(event: H3Event, action: () => Promise<T> | T): Promise<T> {
  requireAdminAuth(event);
  try { return await action(); }
  catch (error: any) {
    const status = Number(error?.status || error?.statusCode);
    throw createError({ statusCode: Number.isInteger(status) && status >= 400 && status < 600 ? status : 503, statusMessage: error?.message || "Telegram MTProto 操作失败" });
  }
}
