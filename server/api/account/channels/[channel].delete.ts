import { createError, defineEventHandler, getRouterParam } from "h3";
import { getStoredChannels, requireSameOriginUserRequest, requireUserSession, updateStoredChannels } from "../../../utils/userAuth";
import { TG_CHANNEL_PATTERN } from "../../../../utils/telegramChannels";
export default defineEventHandler((event) => { requireSameOriginUserRequest(event); const context = requireUserSession(event); const channel = String(getRouterParam(event, "channel") || "").toLowerCase(); if (!TG_CHANNEL_PATTERN.test(channel)) throw createError({ statusCode: 400, statusMessage: "频道格式无效" }); const channels = getStoredChannels(context.user).filter((x) => x !== channel); updateStoredChannels(context.user.id, channels); return { ok: true, channels, count: channels.length }; });
