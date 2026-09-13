import { defineEventHandler } from "h3";
import { cancelPhoneLogin, cancelQrLogin, logout } from "../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, async () => { cancelQrLogin(); cancelPhoneLogin(); await logout(); return { ok: true }; }));
