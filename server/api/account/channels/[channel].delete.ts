import { createError, defineEventHandler, getRouterParam } from "h3";
import { setPrivateNoStore } from "../../../utils/apiResponse";
import { getStoredChannels, requireSameOriginUserRequest, requireUserSession, updateStoredChannels } from "../../../utils/userAuth";
import { CHANNEL_NAME_PATTERN } from "../../../../utils/customChannels";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由。
 * 前台写自定义频道走 composables/useSettings.ts 的 POST /api/account/channels
 * （整表覆盖），所以单条删除是一个冗余入口。
 * 保留待定；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  setPrivateNoStore(event);
  requireSameOriginUserRequest(event);
  const context = requireUserSession(event);
  const channel = String(getRouterParam(event, "channel") || "").toLowerCase();
  if (!CHANNEL_NAME_PATTERN.test(channel)) {
    throw createError({ statusCode: 400, statusMessage: "频道格式无效" });
  }
  const channels = getStoredChannels(context.user).filter((item) => item !== channel);
  updateStoredChannels(context.user.id, channels);
  return { ok: true, channels, count: channels.length };
});
