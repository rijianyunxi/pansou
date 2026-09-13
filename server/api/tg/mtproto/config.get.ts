import { defineEventHandler } from "h3";
import { hasMtprotoCredentials } from "../../../utils/telegramConfig";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, () => ({ configured: hasMtprotoCredentials() })));
