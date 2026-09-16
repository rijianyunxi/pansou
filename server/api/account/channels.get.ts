import { defineEventHandler } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import { getStoredChannels, requireUserSession } from "../../utils/userAuth";
export default defineEventHandler((event) => { const context = requireUserSession(event); const channels = getStoredChannels(context.user); const policy = getUserPolicy(); return { channels, limit: policy.loggedChannelLimit, count: channels.length }; });
