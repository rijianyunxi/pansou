import { createError, defineEventHandler, readBody } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import { setPrivateNoStore } from "../../utils/apiResponse";
import { MAX_USER_CHANNELS, normalizeChannelNames, CHANNEL_NAME_PATTERN } from "../../../utils/customChannels";
import {
  getUserSession,
  requireSameOriginUserRequest,
  updateStoredChannels,
  updateStoredSessionChannels,
} from "../../utils/userAuth";

export default defineEventHandler(async (event) => {
  setPrivateNoStore(event);
  requireSameOriginUserRequest(event);
  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。" });
  }

  const body = await readBody<{ channels?: unknown }>(event);
  if (!Array.isArray(body?.channels) || body.channels.some((x) => typeof x !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "频道列表必须是字符串数组。" });
  }
  const channels = normalizeChannelNames((body.channels as string[]).map((x) => x.trim()).filter(Boolean));
  const limit = Math.min(MAX_USER_CHANNELS, policy.customChannelLimit);
  if (channels.length > limit || channels.some((x) => !CHANNEL_NAME_PATTERN.test(x))) {
    throw createError({ statusCode: 400, statusMessage: `频道数量不能超过 ${limit} 个，且必须为有效公开频道。` });
  }

  if (context.user) {
    return {
      ok: true,
      channels,
      limit,
      count: channels.length,
      anonymousCustomChannels: policy.anonymousCustomChannels,
      user: updateStoredChannels(context.user.id, channels),
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
