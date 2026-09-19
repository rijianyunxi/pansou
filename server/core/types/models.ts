import type { WarningInfo } from "../utils/errors";
import type { CloudType } from "../../../shared/cloudTypes";

export type { CloudType } from "../../../shared/cloudTypes";

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

export type ResourceCheckStatus = "unchecked" | "checking" | "valid" | "invalid" | "unknown";

export type SourceExecutionStatus = "success" | "failed" | "skipped";

export interface SearchSourceMeta {
  id: string;
  name: string;
  priority: number;
  status: SourceExecutionStatus;
  /** Number emitted by this source before cross-source identity/link deduplication. */
  resultCount: number;
  elapsedMs: number;
  /** Time spent executing and validating this source transform; null when not run. */
  transformMs: number | null;
  /** Proxy node(s) used for this source; direct requests are reported as `直连`. */
  proxyNode: string;
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
  /** Stable source id that produced this streamed batch. */
  sourceId: string;
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
}
