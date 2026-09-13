import { defineEventHandler, readBody } from "h3";
import { sendLoginCode } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler(async (event) => withTelegramMtproto(event, async () => sendLoginCode(String((await readBody(event))?.phone || "").trim())));
