import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import {
  getStoredChannels,
  getUserSession,
  requireSameOriginUserRequest,
  updateStoredChannels,
  updateStoredSessionChannels,
} from "../../utils/userAuth";

export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "private, no-store");
  requireSameOriginUserRequest(event);
  const context = getUserSession(event, { createAnonymous: true, allowMustChange: true });
  const policy = getUserPolicy();
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "自定义频道仅对登录用户开放，请先登录或注册。" });
  }

  const body = await readBody<{ channels?: unknown }>(event);
  if (!Array.isArray(body?.channels) || body.channels.some((x) => typeof x !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "频道列表必须是字符串数组。" });
  }
  const channels = normalizeTelegramChannels((body.channels as string[]).map((x) => x.trim()).filter(Boolean));
  const limit = Math.min(MAX_USER_TG_CHANNELS, policy.customChannelLimit);
  if (channels.length > limit || channels.some((x) => !TG_CHANNEL_PATTERN.test(x))) {
    throw createError({ statusCode: 400, statusMessage: `频道数量不能超过 ${limit} 个，且必须为有效公开频道。` });
  }

  if (context.user) {
    const user = updateStoredChannels(context.user.id, channels);
    return {
      ok: true,
      channels,
      limit,
      count: channels.length,
      anonymousCustomChannels: policy.anonymousCustomChannels,
      user,
    };
  }

  updateStoredSessionChannels(context.session.id, channels);
  return {
    ok: true,
    channels,
    limit,
    count: channels.length,
    anonymousCustomChannels: policy.anonymousCustomChannels,
  };
});
