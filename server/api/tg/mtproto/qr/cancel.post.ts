import { defineEventHandler } from "h3";
import { cancelQrLogin } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, () => { cancelQrLogin(); return { ok: true }; }));
