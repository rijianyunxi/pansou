import type { PluginManifest } from "../plugins/manager";

export type SourceInputFormat = "html" | "json" | "text";
export type SourceScalar = string | number | boolean | null;
export type SourceValue =
  | SourceScalar
  | SourceValue[]
  | { [key: string]: SourceValue };

export interface SourceRetryConfig {
  /** Retries after the first request to the same URL (0-3). */
  maxRetries?: number;
  /** Delay before retrying the same URL (0-5000ms). */
  delayMs?: number;
}

export interface SourceRequest {
  method: "GET" | "POST";
  url: string;
  retry?: SourceRetryConfig;
  query?: Record<string, SourceValue>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: SourceValue;
  maxResponseBytes?: number;
  redirect?: "error" | "follow";
  allowedDomains?: string[];
  allowInsecureHttp?: boolean;
  maxRequestBodyBytes?: number;
}

export interface SourceResponse {
  format: "json" | "html";
  /** Synchronous transform that returns canonical SearchResult records. */
  transform: string;
}

export interface SourceDefinition {
  schemaVersion: 1;
  manifest: PluginManifest;
  request: SourceRequest;
  response: SourceResponse;
}

export interface SourceTransformDefinition {
  id: string;
  version: string;
  format: SourceInputFormat | "auto";
  maxResults: number;
  code: string;
}

export interface SourceTransformContext {
  channel?: string;
  keyword?: string;
  source?: string;
  url?: string;
  page?: number;
  /** Route selected by a source request (for example telegram or jina). */
  route?: string;
  rawBody: string;
  format: SourceInputFormat;
}

export interface SourceExecutionTrace {
  stage: string;
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  contentType?: string;
  request?: {
    url: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body?: unknown;
  };
  error?: string;
}

export interface SourceExecutionResult {
  results: import("../types/models").SearchResult[];
  traces: SourceExecutionTrace[];
  /** Admin-only debug payload preview. */
  raw: string;
  rawTruncated: boolean;
}

export interface SourceExecutionBudgetOptions {
  /** Total HTTP requests per call; the main request and retries share it. */
  maxTotalRequests?: number;
  /** Cumulative request + response payload bytes per call. */
  maxTotalBytes?: number;
}
