import { createError } from "h3";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";
export const MAX_SYSTEM_TG_CHANNELS = 200;

/**
 * 每频道抓取策略（M6）。
 *
 * 未配置的字段沿用全局默认；整份策略按频道用户名（小写）为键存储。
 */
export interface TgChannelPolicy {
  /** 最多抓取的分页数 */
  maxPages?: number | null;
  /** 单频道结果数上限 */
  maxResults?: number | null;
  /** fallback 策略：仅直连 / 仅 Jina；缺省表示"先直连、失败后 Jina" */
  fallback?: "direct" | "jina" | null;
  /** 频道专属备用 URL 模板，支持 {{channel}}/{{keyword}}/{{before}}。 */
  fallbackUrls?: string[] | null;
  /** 每个 URL 的重试次数（不含首次请求）。 */
  maxRetries?: number | null;
  /** 同一 URL 重试前的基础等待时间。 */
  retryDelayMs?: number | null;
}

export type TgChannelPolicyMap = Record<string, TgChannelPolicy>;

/**
 * 每频道覆盖状态（M7 频道启停/删除）：管理员对频道清单的 additive 覆盖。
 * - enabled: false 表示已关闭（不参与正式搜索）；
 * - deleted: true 表示已删除（内置默认频道以覆盖方式标记，自定义频道从清单移除）。
 * 两个字段始终成对出现；没有任何覆盖信息（enabled && !deleted）的条目会被丢弃。
 */
export interface TgChannelStateEntry {
  enabled: boolean;
  deleted: boolean;
}

export type TgChannelStateMap = Record<string, TgChannelStateEntry>;

export const TG_POLICY_RANGES = {
  maxPages: { min: 1, max: 50 },
  maxResults: { min: 1, max: 200 },
  maxRetries: { min: 0, max: 3 },
  retryDelayMs: { min: 0, max: 5_000 },
} as const;

const NUMERIC_POLICY_FIELDS = ["maxPages", "maxResults", "maxRetries", "retryDelayMs"] as const;
export type TgChannelPolicyField = (typeof NUMERIC_POLICY_FIELDS)[number] | "fallback" | "fallbackUrls";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验每频道策略入参（管理员 API 用，非法即 400）。
 * - null 表示清空全部策略；普通对象按频道用户名逐一校验。
 * - 键名会做 @ 前缀去除与大小写归一；策略内部未知字段被忽略。
 * - 无任何有效字段的空策略会被丢弃。
 */
export function parseChannelPolicies(value: unknown): TgChannelPolicyMap | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw createError({ statusCode: 400, statusMessage: "policies must be null or an object keyed by channel username" });
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_SYSTEM_TG_CHANNELS) {
    throw createError({ statusCode: 400, statusMessage: `policies support at most ${MAX_SYSTEM_TG_CHANNELS} channels` });
  }
  const out: TgChannelPolicyMap = {};
  for (const rawKey of keys) {
    const name = String(rawKey).trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(name)) {
      throw createError({ statusCode: 400, statusMessage: `invalid policy channel username: ${String(rawKey).slice(0, 64)}` });
    }
    const rawPolicy = value[rawKey];
    if (rawPolicy === null) continue;
    if (!isPlainObject(rawPolicy)) {
      throw createError({ statusCode: 400, statusMessage: `policy for ${name} must be an object` });
    }
    const policy: TgChannelPolicy = {};
    for (const field of NUMERIC_POLICY_FIELDS) {
      const range = TG_POLICY_RANGES[field];
      const input = rawPolicy[field];
      if (input === undefined || input === null) continue;
      if (typeof input !== "number" || !Number.isInteger(input) || input < range.min || input > range.max) {
        throw createError({
          statusCode: 400,
          statusMessage: `policy.${field} for ${name} must be an integer between ${range.min} and ${range.max}`,
        });
      }
      policy[field] = input;
    }
    const fallback = rawPolicy.fallback;
    if (fallback !== undefined && fallback !== null) {
      if (fallback !== "direct" && fallback !== "jina") {
        throw createError({ statusCode: 400, statusMessage: `policy.fallback for ${name} must be "direct" or "jina"` });
      }
      policy.fallback = fallback;
    }
    const fallbackUrls = rawPolicy.fallbackUrls;
    if (fallbackUrls !== undefined && fallbackUrls !== null) {
      if (!Array.isArray(fallbackUrls) || fallbackUrls.length > 3 || fallbackUrls.some((url) => typeof url !== "string" || !url.trim())) {
        throw createError({ statusCode: 400, statusMessage: `policy.fallbackUrls for ${name} must contain at most 3 non-empty URL templates` });
      }
      policy.fallbackUrls = [...new Set(fallbackUrls.map((url) => url.trim().slice(0, 500)))];
    }
    if (Object.keys(policy).length) out[name] = policy;
  }
  return out;
}

/**
 * 校验系统频道清单入参（管理员 API 用，非法即 400）。
 * - null 表示恢复内置默认；必须是字符串数组，逐项做 @ 前缀去除与大小写归一。
 * - 数组长度（去重前）不得超过 MAX_SYSTEM_TG_CHANNELS；任何非法用户名都会整体拒绝。
 */
export function parseSystemChannels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw createError({ statusCode: 400, statusMessage: "channels must be null or an array of public usernames" });
  }
  if (value.length > MAX_SYSTEM_TG_CHANNELS) {
    throw createError({ statusCode: 400, statusMessage: `channels support at most ${MAX_SYSTEM_TG_CHANNELS} entries` });
  }
  const normalized = normalizeTelegramChannels(value as string[]);
  for (const name of normalized) {
    if (!TG_CHANNEL_PATTERN.test(name)) {
      throw createError({ statusCode: 400, statusMessage: `invalid channel username: ${name.slice(0, 64)}` });
    }
  }
  return normalized;
}

/**
 * 宽松清洗每频道覆盖状态（用于读取磁盘上的历史数据）：非法条目直接丢弃。
 * - 键名做 @ 前缀去除与大小写归一，必须匹配公开用户名 pattern；
 * - enabled / deleted 必须是布尔值，否则回退默认（true / false）；
 * - 没有任何覆盖信息（enabled && !deleted）的条目被丢弃，保持存储最小化。
 */
export function sanitizeChannelStates(value: unknown): TgChannelStateMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: TgChannelStateMap = {};
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const name = String(rawKey).trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(name) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const input = rawEntry as Record<string, unknown>;
    const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
    const deleted = typeof input.deleted === "boolean" ? input.deleted : false;
    if (enabled && !deleted) continue;
    out[name] = { enabled, deleted };
  }
  return out;
}

/** 归一频道动作入参：去空白、去 @ 前缀、小写。 */
export function normalizeTgChannelParam(value: string | undefined | null): string {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * 频道来源：出现在自定义清单（searchSettings.channels）中的是 custom；
 * 其余（内置默认、或仅存在于覆盖/健康数据中的频道）按 builtin / custom 兜底：
 * 不在内置默认清单里的频道视为管理员手动添加的 custom。
 */
export function tgChannelOrigin(
  channel: string,
  customChannels: string[] | null,
  builtinDefaults: string[],
): "builtin" | "custom" {
  const name = normalizeTgChannelParam(channel);
  const custom = new Set(normalizeTelegramChannels(customChannels ?? []));
  if (custom.has(name)) return "custom";
  const builtin = new Set(normalizeTelegramChannels(builtinDefaults ?? []));
  if (builtin.has(name)) return "builtin";
  return "custom";
}

export function telegramSettingsView(channels: string[] | null, defaults: string[], policies?: TgChannelPolicyMap | null) {
  const defaultChannels = normalizeTelegramChannels(defaults).filter((name) => TG_CHANNEL_PATTERN.test(name));
  return {
    channels,
    defaultChannels,
    effectiveChannels: channels ?? defaultChannels,
    policies: policies ?? {},
  };
}
