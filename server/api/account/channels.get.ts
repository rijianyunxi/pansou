import { createError, defineEventHandler, setHeader } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import {
  getStoredChannels,
  getStoredSessionChannels,
  getUserSession,
} from "../../utils/userAuth";

export default defineEventHandler((event) => {
  setHeader(event, "Cache-Control", "private, no-store");
  const context = getUserSession(event, { createAnonymous: true, allowMustChange: true });
  const policy = getUserPolicy();
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "自定义频道仅对登录用户开放，请先登录或注册。" });
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
