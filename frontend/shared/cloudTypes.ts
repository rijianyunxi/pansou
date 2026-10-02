export const CLOUD_TYPE_LABELS: Readonly<Record<string, string>> = {
  baidu: "百度网盘",
  quark: "夸克网盘",
  guangya: "光鸭网盘",
  aliyun: "阿里云盘",
  uc: "UC网盘",
  mobile: "中国移动云盘",
  tianyi: "天翼云盘",
  "115": "115网盘",
  "123": "123云盘",
  jianguoyun: "坚果云",
  lanzou: "蓝奏云",
  xunlei: "迅雷云盘",
  magnet: "磁力链接",
  others: "其他",
};

/** Short labels used by compact admin controls. */
export const CLOUD_TYPE_SHORT_LABELS: Readonly<Record<string, string>> = {
  baidu: "百度",
  quark: "夸克",
  guangya: "光鸭",
  aliyun: "阿里云",
  uc: "UC",
  mobile: "移动",
  tianyi: "天翼",
  "115": "115",
  "123": "123",
  jianguoyun: "坚果云",
  lanzou: "蓝奏",
  xunlei: "迅雷",
  magnet: "磁力",
  others: "其他",
};

/** Stable presentation order shared by the web filters and resource cards. */
export function sortCloudTypes(types: readonly string[]): string[] {
  const fixedRank = (type: string): number => type === "quark" ? 0 : type === "baidu" ? 1 : 2;
  return [...new Set(types)].map((type, index) => ({ type, index })).sort((left, right) => {
    const rankDiff = fixedRank(left.type) - fixedRank(right.type);
    return rankDiff || left.index - right.index;
  }).map(({ type }) => type);
}

