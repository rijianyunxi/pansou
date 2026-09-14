export interface AdapterMapping {
  /** JSON dot path or HTML item selector. */
  items: string;
  /** JSON field path or HTML selector. */
  title: string;
  /** JSON field path or HTML URL selector; empty means the current link node. */
  url: string;
  type: string;
  password: string;
  linkArray?: string;
  content?: string;
  datetime?: string;
}

export interface UpstreamRequestConfig {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect?: "error" | "follow";
  allowedDomains?: string[];
  maxRequestBodyBytes?: number;
  secrets?: string[];
  stages?: unknown[];
}

export interface UpstreamResponseConfig {
  nextPage?: {
    selector?: string;
    queryParam?: string;
    maxPages?: number;
  };
}

export type UpstreamSourceKind = "http" | "telegram";

export interface UpstreamDefinition {
  id: string;
  /** One directory model for HTTP endpoints and Telegram channel sources. */
  sourceKind?: UpstreamSourceKind;
  /** Public Telegram username when sourceKind is telegram. */
  channel?: string;
  name: string;
  description: string;
  url: string;
  /** Management labels, independent from drive/resource classification. */
  tags?: string[];
  /** Cloud drive category, e.g. aliyun, quark, baidu, magnet. */
  driveType?: string;
  /** Resource categories, e.g. movie, anime, novel, music, document. */
  resourceTypes?: string[];
  method: "GET" | "POST";
  format: "json" | "html";
  plugin: string;
  adapter: string;
  color: string;
  initials: string;
  mapping: AdapterMapping;
  /** Whether this configured source participates in formal search. */
  enabled?: boolean;
  /** Declarative request/response details used by the generic configured executor. */
  request?: UpstreamRequestConfig;
  /** Sandboxed synchronous transform(payload, $, context) source. */
  transform?: string;
  response?: UpstreamResponseConfig;
}

export type ProbeState = "available" | "warning" | "error";
export interface ProbeRequestDetails {
  url: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body?: unknown;
}
export interface ProbeTrace {
  stage?: string;
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  contentType: string;
  request?: ProbeRequestDetails;
  error?: string;
}
export interface UpstreamProbe {
  sourceId: string;
  checkedAt: string;
  state: ProbeState;
  message: string;
  elapsedMs: number;
  httpStatus: number | null;
  businessCode?: string;
  traces: ProbeTrace[];
  raw: string;
  rawTruncated: boolean;
  results: import("../server/core/types/models").SearchResult[];
}
