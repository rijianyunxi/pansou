import type { WarningInfo } from "../utils/errors";

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
}

export type SourceExecutionStatus = "success" | "failed" | "skipped";

export interface SearchSourceMeta {
  id: string;
  name: string;
  status: SourceExecutionStatus;
  resultCount: number;
  elapsedMs: number;
}

export interface SearchResponseMeta {
  sources: SearchSourceMeta[];
  warnings: WarningInfo[];
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
  request: {
    keyword: string;
    phase: "source";
  };
  results: SearchResult[];
}

export interface SearchStreamResultData {
  update: SearchSourceUpdate;
}

export interface SearchStreamCompleteData {
  total: number;
}

export interface GenericResponse<T> {
  code: number;
  message: string;
  data?: T;
}

export interface SearchRequest {
  kw: string;
  channels?: string[];
  sourceIds?: string[];
  conc?: number;
  refresh?: boolean;
  ext?: Record<string, any>;
  cloud_types?: string[];
}
