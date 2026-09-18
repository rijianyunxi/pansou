/**
 * 仅用于首次创建 SQLite 系统配置记录。
 * 资源源不提供内置值，全部由管理员配置。
 */
export const SYSTEM_DEFAULTS = {
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  cacheTtlMinutes: 10,
} as const;
