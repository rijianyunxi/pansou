export interface SourceManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "source";
  readonly maxResults: number;
  readonly schemaVersion: number;
  readonly outputTypes: readonly string[];
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export type SourceInputFormat = "html" | "json" | "text";
export type SourceScalar = string | number | boolean | null;
export type SourceValue =
  | SourceScalar
  | SourceValue[]
  | { [key: string]: SourceValue };

export interface SourceRequest {
  method: "GET" | "POST";
  url: string;
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
  format: "json" | "html" | "text";
  /** Synchronous transform that returns canonical SearchResult records. */
  transform: string;
}

export interface SourceDefinition {
  schemaVersion: 1;
  manifest: SourceManifest;
  proxyPool?: "telegram";
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
  keyword?: string;
  source?: string;
  url?: string;
  rawBody: string;
  format: SourceInputFormat;
  [key: string]: unknown;
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
