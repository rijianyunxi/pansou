import type { PluginManifest } from "../plugins/manager";

export type InstructionScalar = string | number | boolean | null;
export type InstructionValue =
  | InstructionScalar
  | InstructionValue[]
  | { [key: string]: InstructionValue };

/**
 * Restricted regex extraction applied to an already-extracted field value.
 * Patterns are bounded in length, limited to the i/m/s/u flags, and matched
 * against at most 10,000 characters — no eval, no user functions.
 */
export interface InstructionFieldRegex {
  pattern: string;
  flags?: string;
  /** Capture group to return; defaults to 1 when the pattern has groups, else 0. */
  group?: number;
}

export interface InstructionField {
  path?: string;
  selector?: string;
  source?: "text" | "html" | "href" | "attr" | "constant";
  attribute?: string;
  value?: InstructionValue;
  default?: InstructionScalar;
  transform?: "string" | "number" | "boolean";
  prefix?: string;
  suffix?: string;
  regex?: InstructionFieldRegex;
}

export interface InstructionLinks {
  array?: string;
  selector?: string;
  url: InstructionField | string;
  type?: InstructionField | string;
  password?: InstructionField | string;
}

export interface InstructionRetryConfig {
  /** Retries after the first request for each URL (0-3). */
  maxRetries?: number;
  /** Delay before retrying the same URL (0-5000ms). */
  delayMs?: number;
}

export interface InstructionRequest {
  method: "GET" | "POST";
  url: string;
  /** Explicit fallback endpoints tried after the primary URL is exhausted. */
  fallbackUrls?: string[];
  /** Bounded retry policy applied independently to every endpoint. */
  retry?: InstructionRetryConfig;
  query?: Record<string, InstructionValue>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: InstructionValue;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect?: "error" | "follow";
  allowedDomains?: string[];
  /** HTTP is disabled by default; enable only for an audited legacy upstream. */
  allowInsecureHttp?: boolean;
  maxRequestBodyBytes?: number;
  /** Secret variable names (referenced as {{secret.name}}); values live in a separate store. */
  secrets?: string[];
  /** Pre-main stages (max 2) that extract token/buildId style variables. */
  stages?: InstructionStageRequest[];
}

export interface InstructionStageResponse {
  format: "json" | "html";
  /** Variable extraction map: name -> dot path (json) / selector (html) / field spec. */
  vars: Record<string, InstructionField | string>;
}

export interface InstructionStageRequest {
  method?: "GET" | "POST";
  url: string;
  /** Explicit fallback endpoints tried after the primary URL is exhausted. */
  fallbackUrls?: string[];
  /** Bounded retry policy applied independently to every endpoint. */
  retry?: InstructionRetryConfig;
  query?: Record<string, InstructionValue>;
  headers?: Record<string, string>;
  bodyType?: "json" | "form";
  body?: InstructionValue;
  timeoutMs?: number;
  maxResponseBytes?: number;
  response: InstructionStageResponse;
}

export interface InstructionResponse {
  format: "json" | "html";
  items: string;
  fields: {
    title: InstructionField | string;
    content?: InstructionField | string;
    datetime?: InstructionField | string;
    messageId?: InstructionField | string;
    uniqueId?: InstructionField | string;
  };
  links: InstructionLinks;
  /** Sandboxed synchronous transform(payload, $, context) used instead of field mapping. */
  transform?: string;
  nextPage?: {
    /** HTML only: selector of the next-page anchor whose href is followed. */
    selector?: string;
    /** Query parameter carrying the page number (e.g. "page"). */
    queryParam?: string;
    /** Pages to fetch at most; defaults to 3, hard cap 10. */
    maxPages?: number;
  };
}

export interface InstructionPluginDefinition {
  schemaVersion: 1;
  manifest: PluginManifest;
  request: InstructionRequest;
  response: InstructionResponse;
}

export interface InstructionExecutionTrace {
  stage: string;
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  error?: string;
}
