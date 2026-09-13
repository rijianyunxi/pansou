import QRCode from "qrcode";
import { defineEventHandler } from "h3";
import { getLoginState } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler((event) => withTelegramMtproto(event, async () => {
  const state = getLoginState();
  return { ...state, qrDataUrl: state.qrToken ? await QRCode.toDataURL(`tg://login?token=${state.qrToken}`, { margin: 1, width: 280 }) : null };
}));
