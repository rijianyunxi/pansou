export interface UpstreamRequestConfig {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: unknown;
  maxResponseBytes?: number;
  redirect?: "error" | "follow";
  allowedDomains?: string[];
  maxRequestBodyBytes?: number;
}

/** Every searchable source is the same request + response transform contract. */
export interface UpstreamDefinition {
  id: string;
  name: string;
  description: string;
  url: string;
  method: "GET" | "POST";
  format: "json" | "html";
  enabled?: boolean;
  request?: UpstreamRequestConfig;
  transform: string;
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
