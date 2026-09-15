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
  type: CloudType;
  url: string;
  password: string | null;
}

export type SearchResultSource = "telegram" | "plugin";

/** Canonical resource-level result used internally and returned by search APIs. */
export interface SearchResult {
  id: string;
  name: string;
  description: string | null;
  datetime: string | null;
  cloud_types: CloudType[];
  links: Link[];
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

/** Response assembled from source adapters. Results already use the public contract. */
export interface SearchExecutionResponse {
  total: number;
  results: SearchResult[];
  meta?: SearchResponseMeta;
}

/** The resource-level shape returned by both search APIs. */
export interface SearchResponse {
  total: number;
  results: SearchResult[];
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
  /** Search only server-configured sources. User channel searches use /api/search/channels. */
  kw: string;
  conc?: number;
  refresh?: boolean;
  /** Include warnings, response metadata, and result provenance fields. */
  debug?: boolean;
  src?: "all" | "tg" | "plugin";
  plugins?: string[];
  ext?: Record<string, any>;
  cloud_types?: string[];
}
