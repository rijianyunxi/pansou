export interface SafeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxRequestBodyBytes: number;
  maxResponseBytes: number;
  maxRedirects: number;
  followRedirects: boolean;
  expectedContentTypes: readonly string[];
  allowedDomains?: readonly string[];
  allowHttp?: boolean;
}

export interface SafeHttpResponse {
  response: Response;
  url: URL;
  body: string;
  bytes: number;
  contentType: string;
  redirects: number;
  elapsedMs: number;
}

