import { defineEventHandler } from "h3";
import { getCurrentUser } from "../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, getCurrentUser));
