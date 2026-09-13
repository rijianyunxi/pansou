import { defineEventHandler, getQuery } from "h3";
import { searchChannelMessages } from "../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, () => {
  const query = getQuery(event);
  return searchChannelMessages(String(query.channel || "").trim(), String(query.q || "").trim(), Number(query.limit || 20), Number(query.offsetId || 0));
}));
