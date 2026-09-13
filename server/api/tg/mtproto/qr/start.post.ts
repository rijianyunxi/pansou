import { defineEventHandler } from "h3";
import { startQrLogin } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, async () => { await startQrLogin(); return { started: true }; }));
