import { defineEventHandler } from "h3";
import { getMyChannels } from "../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, () => getMyChannels().then((items) => ({ items }))));
