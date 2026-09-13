// 平台信息配置
export const PLATFORM_INFO: Record<
  string,
  { name: string; color: string; icon: string }
> = {
  aliyun: { name: "阿里云盘", color: "#7c3aed", icon: "☁️" },
  quark: { name: "夸克网盘", color: "#6366f1", icon: "🔎" },
  baidu: { name: "百度网盘", color: "#2563eb", icon: "🧰" },
  "115": { name: "115网盘", color: "#f59e0b", icon: "📦" },
  xunlei: { name: "迅雷云盘", color: "#fbbf24", icon: "⚡" },
  uc: { name: "UC网盘", color: "#ef4444", icon: "🧭" },
  tianyi: { name: "天翼云盘", color: "#ec4899", icon: "☁️" },
  "123": { name: "123网盘", color: "#10b981", icon: "#" },
  mobile: { name: "移动云盘", color: "#0ea5e9", icon: "📱" },
  others: { name: "其他网盘", color: "#6b7280", icon: "…" },
};

// 本地存储键名
export const STORAGE_KEYS = {
  settings: "panhub.settings",
  searchMode: "searchMode",
} as const;
