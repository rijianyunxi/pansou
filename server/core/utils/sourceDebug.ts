import { redactSensitiveUrl } from "./redaction";

const DEBUG = process.env.PANHUB_DEBUG === "1" || process.env.LOG_LEVEL === "debug";

export function previewBody(value: unknown, max = 1000): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…(truncated)` : text;
}

export function errorSummary(error: unknown): string {
  const value = error as { name?: unknown; code?: unknown; statusCode?: unknown; cause?: unknown; response?: { status?: unknown }; message?: unknown } | null;
  const cause = value?.cause as { code?: unknown; message?: unknown } | undefined;
  const status = typeof value?.statusCode === "number" || typeof value?.statusCode === "string"
    ? `status=${value.statusCode}`
    : typeof value?.response?.status === "number" || typeof value?.response?.status === "string"
      ? `status=${value.response.status}`
      : "";
  const parts = [
    typeof value?.name === "string" ? value.name : "",
    typeof value?.code === "string" ? value.code : "",
    status,
    typeof cause?.code === "string" ? `cause=${cause.code}` : "",
    typeof value?.message === "string" ? value.message : String(error ?? "unknown error"),
    typeof cause?.message === "string" && cause.message !== value?.message ? `cause=${cause.message}` : "",
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 1200);
}

export function logSourceRequest(
  phase: "start" | "success" | "error",
  details: {
    source?: string;
    method: string;
    url: string;
    elapsedMs?: number;
    status?: number | null;
    bytes?: number;
    contentType?: string;
    body?: unknown;
    error?: unknown;
    responsePreview?: unknown;
    attempt?: number;
  },
): void {
  // Errors are always printed because a failed source is otherwise silently
  // converted into a partial search result. Successful request bodies are only
  // printed in debug mode to avoid noisy production logs.
  if (phase === "start" && !DEBUG) return;
  if (phase === "success" && !DEBUG) return;
  const prefix = `[PanHub][source][${phase}]`;
  const source = details.source ? ` source=${details.source}` : "";
  const attempt = details.attempt ? ` attempt=${details.attempt}` : "";
  const base = `${prefix}${source}${attempt} ${details.method} ${redactSensitiveUrl(details.url)}`;
  if (phase === "error") {
    console.error(`${base} elapsed=${details.elapsedMs ?? 0}ms error=${errorSummary(details.error)}`);
    return;
  }
  const response = `status=${details.status ?? "?"} elapsed=${details.elapsedMs ?? 0}ms bytes=${details.bytes ?? 0} contentType=${details.contentType || "?"}`;
  const preview = details.responsePreview === undefined ? "" : ` preview=${JSON.stringify(previewBody(details.responsePreview))}`;
  const requestBody = details.body === undefined ? "" : ` requestBodyBytes=${Buffer.byteLength(JSON.stringify(details.body))}`;
  console.info(`${base} ${response}${requestBody}${preview}`);
}

export function logSearchSource(
  phase: "start" | "success" | "error",
  details: { source: string; keyword?: string; elapsedMs?: number; resultCount?: number; error?: unknown },
): void {
  const prefix = `[PanHub][search][${phase}] source=${details.source}`;
  const keyword = details.keyword ? ` keyword=${JSON.stringify(details.keyword)}` : "";
  if (phase === "error") {
    console.error(`${prefix}${keyword} elapsed=${details.elapsedMs ?? 0}ms error=${errorSummary(details.error)}`);
  } else if (DEBUG || phase === "success") {
    console.info(`${prefix}${keyword} elapsed=${details.elapsedMs ?? 0}ms results=${details.resultCount ?? 0}`);
  }
}

export function logSearchStreamEvent(name: string, payload: unknown): void {
  if (!DEBUG) return;
  console.info(`[PanHub][search][sse] event=${name} payload=${JSON.stringify(payload)}`);
}
