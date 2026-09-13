import { defineEventHandler, getQuery } from "h3";
import { getChannelMessages } from "../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, () => {
  const query = getQuery(event);
  return getChannelMessages(String(query.channel || "").trim(), Number(query.limit || 20)).then((items) => ({ items }));
}));
