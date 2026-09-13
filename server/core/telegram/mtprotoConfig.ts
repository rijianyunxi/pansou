import path from "node:path";

export const mtprotoConfig = {
  apiId: Number(process.env.TELEGRAM_API_ID || 0),
  apiHash: String(process.env.TELEGRAM_API_HASH || "").trim(),
  sessionFile: path.resolve(process.env.TELEGRAM_SESSION_FILE || "./data/telegram-session.txt"),
};

export function hasMtprotoCredentials(): boolean {
  return Number.isInteger(mtprotoConfig.apiId) && mtprotoConfig.apiId > 0 && mtprotoConfig.apiHash.length > 0;
}
