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
  /** Optional poster/cover URLs collected by a source transform. */
  images?: string[];
}

export type ResourceCheckStatus = "unchecked" | "checking" | "valid" | "invalid" | "unknown";

export type SourceExecutionStatus = "success" | "failed" | "skipped";

export type ProxyNodeRequestStatus = "success" | "failed";

/** One concrete proxy/direct attempt made while executing a resource source. */
export interface ProxyNodeMeta {
  /** Stable configured node ID, or `direct` for a direct request. */
  nodeId: string;
  /** Display name captured when the node was selected. */
  nodeName: string;
  /** Attempt order within this source request. */
  attempt: number;
  /** Transport-level outcome for this attempt. */
  status: ProxyNodeRequestStatus;
  /** HTTP status when a response was received; null for network failures/timeouts. */
  httpStatus: number | null;
  /** Time spent on this concrete node attempt. */
  elapsedMs: number;
  /** Redacted/truncated error text when this attempt failed. */
  error?: string;
}

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
  /** Every proxy/direct attempt made for this source, in execution order. */
  proxyNodes: ProxyNodeMeta[];
}

/** Source diagnostics plus the raw results returned by that source. */
export interface SearchDebugSource extends SearchSourceMeta {
  results: SearchResult[];
}

/** Response assembled from source adapters. Results already use the public contract. */
export interface SearchExecutionResponse {
  total: number;
  results: SearchResult[];
  sources?: SearchSourceMeta[];
}

/** The resource-level shape returned by both search APIs. */
export interface SearchResponse {
  total: number;
  results: SearchResult[];
}

export interface SearchSourceUpdate {
  /** Stable source id that produced this streamed batch. Server-side only. */
  sourceId: string;
  results: SearchResult[];
}

/**
 * Wire shape of a streamed result batch. The source identity is deliberately
 * omitted: the crawler catalogue is site-internal, and clients merge batches
 * by links alone, so they never need to know which source produced a batch.
 */
export interface SearchStreamResultData {
  results: SearchResult[];
}

export interface SearchStreamCompleteData {
  total: number;
}

export interface SearchRequest {
  kw: string;
  channels?: string[];
  sourceIds?: string[];
  conc?: number;
  refresh?: boolean;
}
