import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getTgChannelParsers, getUpstreamParsers } from "../../core/services/tgChannelSettings";
export default defineEventHandler((event) => { requireAdminAuth(event); return { code: 0, data: { telegram: getTgChannelParsers(), upstream: getUpstreamParsers() } }; });
