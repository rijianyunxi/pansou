import { defineEventHandler, readBody } from "h3";
import { checkPhoneLoginPassword, submitPasswordToQrFlow } from "../../../../core/telegram/mtproto";
import { withTelegramMtproto } from "../../../../utils/telegramMtprotoGuard";
export default defineEventHandler(async (event) => withTelegramMtproto(event, async () => { const password = String((await readBody(event))?.password || "").trim(); if (!password) throw new Error("请输入两步验证密码"); if (submitPasswordToQrFlow(password)) return { via: "qr" }; return { ...(await checkPhoneLoginPassword(password)), via: "phone" }; }));
