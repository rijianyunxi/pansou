/**
 * 仅用于首次创建 SQLite 系统配置记录。
 * 数据源和 Telegram 频道不提供任何内置值，全部由管理员配置。
 */
export const SYSTEM_DEFAULTS = {
  priorityChannels: [],
  defaultChannels: [],
  defaultConcurrency: 4,
  pluginTimeoutMs: 5000,
  cacheTtlMinutes: 30,
} as const;
