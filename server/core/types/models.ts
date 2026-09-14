export type CloudType =
  | "baidu"
  | "quark"
  | "aliyun"
  | "mobile"
  | "tianyi"
  | "115"
  | "123"
  | "jianguoyun"
  | "lanzou"
  | "xunlei"
  | "magnet"
  | "others";

export interface Link {
  /** Stable cloud provider identifier inferred from the share URL. */
  type?: CloudType;
  url: string;
  password: string;
}

export type SearchResultSource = "telegram" | "plugin";

/** Internal result shape produced by Telegram, parser plugins and Instructions. */
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
  /** Runtime provenance retained internally and exposed only by debug=1. */
  source?: SearchResultSource;
  pluginId?: string;
  pluginVersion?: string;
  registryVersion?: number;
}

export interface NormalizedCloudLink {
  type: CloudType;
  url: string;
  password: string | null;
}

/** Public resource-level result returned by search APIs. */
export interface NormalizedSearchResult {
  id: string;
  name: string;
  description: string | null;
  datetime: string | null;
  cloud_types: CloudType[];
  links: NormalizedCloudLink[];
  tags?: string[];
  images?: string[];
  /** Only returned when debug=1. */
  source?: SearchResultSource;
  channel?: string;
  pluginId?: string;
  pluginVersion?: string;
  registryVersion?: number;
}

export interface SearchResponseMeta {
  registryVersion: number;
  pluginVersions: Record<string, string>;
}

/** Internal response assembled from source adapters before public normalization. */
export interface SearchExecutionResponse {
  total: number;
  results: SearchResult[];
  meta?: SearchResponseMeta;
}

/** The only public resource shape returned by both search APIs. */
export interface SearchResponse {
  total: number;
  results: NormalizedSearchResult[];
  meta?: SearchResponseMeta;
}

export interface SearchSourceUpdate {
  /** Source execution details are returned only when debug=1. */
  source?: {
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

export interface NormalizedSearchSourceUpdate {
  /** Source execution details are returned only when debug=1. */
  source?: SearchSourceUpdate["source"];
  request: SearchSourceUpdate["request"];
  results: NormalizedSearchResult[];
}

export interface SearchStreamResultData {
  update: NormalizedSearchSourceUpdate;
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
  src?: "all" | "tg" | "plugin";
  plugins?: string[];
  ext?: Record<string, any>;
  cloud_types?: string[];
}
