export interface Link {
  type?: string;
  url: string;
  password: string;
}

export type SearchResultSource = "telegram" | "plugin";

export interface SearchResult {
  message_id: string;
  unique_id: string;
  channel: string;
  datetime: string; // ISO string
  title: string;
  content: string;
  links: Link[];
  tags?: string[];
  images?: string[];
  /** Runtime provenance. Additive fields keep the existing result contract intact. */
  source?: SearchResultSource;
  pluginId?: string;
  pluginVersion?: string;
  registryVersion?: number;
}

export interface MergedLink {
  /** 网盘类型，用于前端平台分组；扁平响应不再依赖 merged_by_type。 */
  type?: string;
  url: string;
  password: string;
  note: string;
  datetime: string; // ISO string
  source?: string; // e.g. "tg:channel" or "plugin:id@version"
  pluginId?: string;
  pluginVersion?: string;
  registryVersion?: number;
  images?: string[];
}

export type MergedLinks = Record<string, MergedLink[]>;

export interface SearchResponseMeta {
  registryVersion: number;
  pluginVersions: Record<string, string>;
}

export type SearchResponseItem = SearchResult | MergedLink;

export interface SearchResponse {
  total: number;
  meta?: SearchResponseMeta;
  /** 默认响应为扁平 MergedLink[]；res=results 时返回原始 SearchResult[]。 */
  results?: SearchResponseItem[];
  /** 仅 res=all 使用，避免再返回按平台嵌套的 merged_by_type。 */
  items?: MergedLink[];
}

export interface SearchSourceUpdate {
  source: {
    kind: SearchResultSource;
    id: string;
    version?: string;
    cached?: boolean;
  };
  request: {
    keyword: string;
    phase: "shallow" | "deep" | "variant" | "cache";
  };
  results: SearchResult[];
}

export interface SearchStreamResultData {
  update: SearchSourceUpdate;
}

export interface SearchStreamCompleteData {
  total: number;
  meta?: SearchResponseMeta;
}

export interface GenericResponse<T> {
  code: number;
  message: string;
  data?: T;
}

export interface SearchRequest {
  /** append (default): system + user channels; only: user TG, no plugins */
  channels_mode?: "append" | "only";
  kw: string;
  channels?: string[];
  conc?: number;
  refresh?: boolean;
  /** Include warnings, response metadata, and result provenance fields. */
  debug?: boolean;
  /** links（默认）返回扁平链接；results 返回原始消息；all 返回两者。 */
  res?: "links" | "all" | "results";
  src?: "all" | "tg" | "plugin";
  plugins?: string[];
  ext?: Record<string, any>;
  cloud_types?: string[];
}
