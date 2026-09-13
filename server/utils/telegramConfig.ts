import { mtprotoConfig, hasMtprotoCredentials } from "../core/telegram/mtprotoConfig";

/** Server-only Telegram app credentials. They are never returned to the browser. */
export function getTelegramAppConfig() { return { apiId: mtprotoConfig.apiId, apiHash: mtprotoConfig.apiHash }; }
export { hasMtprotoCredentials };
