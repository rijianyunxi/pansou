import { createError, defineEventHandler } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import { setPrivateNoStore } from "../../utils/apiResponse";
import {
  getStoredChannels,
  getStoredSessionChannels,
  getUserSession,
} from "../../utils/userAuth";

export default defineEventHandler((event) => {
  setPrivateNoStore(event);
  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。" });
  }
  const channels = context.user
    ? getStoredChannels(context.user)
    : getStoredSessionChannels(context.session);
  return {
    channels,
    limit: policy.customChannelLimit,
    count: channels.length,
    anonymousCustomChannels: policy.anonymousCustomChannels,
  };
});
