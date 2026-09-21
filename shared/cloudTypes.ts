/** Canonical cloud-drive identifiers shared by server normalization and client UI. */
export type CloudType =
  | "baidu"
  | "quark"
  | "guangya"
  | "aliyun"
  | "uc"
  | "mobile"
  | "tianyi"
  | "115"
  | "123"
  | "jianguoyun"
  | "lanzou"
  | "xunlei"
  | "magnet"
  | "others";

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

export const CLOUD_TYPES: CloudType[] = [
  "baidu",
  "quark",
  "aliyun",
  "uc",
  "mobile",
  "tianyi",
  "115",
  "123",
  "jianguoyun",
  "lanzou",
  "xunlei",
  "magnet",
  "others",
  "guangya",
];

/** Stable presentation order shared by the web filters and resource cards. */
export function sortCloudTypes(types: readonly string[]): string[] {
  const fixedRank = (type: string): number => type === "quark" ? 0 : type === "baidu" ? 1 : 2;
  return [...new Set(types)].map((type, index) => ({ type, index })).sort((left, right) => {
    const rankDiff = fixedRank(left.type) - fixedRank(right.type);
    return rankDiff || left.index - right.index;
  }).map(({ type }) => type);
}

export const CLOUD_TYPE_ALIASES: Record<string, CloudType> = {
  baidu: "baidu",
  bdy: "baidu",
  "百度": "baidu",
  quark: "quark",
  "夸克": "quark",
  guangya: "guangya",
  "光鸭": "guangya",
  "光鸭云盘": "guangya",
  aliyun: "aliyun",
  aly: "aliyun",
  alipan: "aliyun",
  "阿里": "aliyun",
  "阿里云盘": "aliyun",
  uc: "uc",
  ucdrive: "uc",
  "uc网盘": "uc",
  "uc云盘": "uc",
  "uc.cn": "uc",
  mobile: "mobile",
  caiyun: "mobile",
  "139": "mobile",
  "中国移动云盘": "mobile",
  tianyi: "tianyi",
  "189cloud": "tianyi",
  "189": "tianyi",
  "天翼": "tianyi",
  "天翼云盘": "tianyi",
  "115": "115",
  "115网盘": "115",
  "123": "123",
  "123pan": "123",
  "123云盘": "123",
  jianguoyun: "jianguoyun",
  "坚果云": "jianguoyun",
  lanzou: "lanzou",
  xunlei: "xunlei",
  thunder: "xunlei",
  "迅雷": "xunlei",
  "迅雷盘": "xunlei",
  lanzoux: "lanzou",
  lanzoui: "lanzou",
  lanzous: "lanzou",
  "蓝奏云": "lanzou",
  magnet: "magnet",
  others: "others",
  other: "others",
  "其他": "others",
};

/** Host suffixes used when inferring a canonical type from a URL. */
export const CLOUD_TYPE_HOSTS: ReadonlyArray<readonly [string, CloudType]> = [
  ["pan.xunlei.com", "xunlei"],
  ["pan.quark.cn", "quark"],
  ["pan.baidu.com", "baidu"],
  ["guangyapan.com", "guangya"],
  ["aliyundrive.com", "aliyun"],
  ["alipan.com", "aliyun"],
  ["drive.uc.cn", "uc"],
  ["yun.139.com", "mobile"],
  ["cloud.189.cn", "tianyi"],
  ["115.com", "115"],
  ["123pan.com", "123"],
  ["123pan.cn", "123"],
  ["123684.com", "123"],
  ["123865.com", "123"],
  ["jianguoyun.com", "jianguoyun"],
  ["lanzou.com", "lanzou"],
  ["lanzoux.com", "lanzou"],
  ["lanzoui.com", "lanzou"],
  ["lanzous.com", "lanzou"],
  ["lanzouq.com", "lanzou"],
  ["lanzouj.com", "lanzou"],
  ["lanzouo.com", "lanzou"],
  ["lanzout.com", "lanzou"],
];
