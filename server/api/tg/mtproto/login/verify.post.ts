import { defineEventHandler, readBody } from "h3";
import { verifyLoginCode } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler(async (event) => withTelegramMtproto(event, async () => verifyLoginCode(String((await readBody(event))?.code || "").trim())));
