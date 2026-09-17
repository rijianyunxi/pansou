import { executeSafeHttp } from "../http/safeHttpExecutor";
import { buildSourceFromTemplate } from "./sourceTemplateSettings";
import { getUnifiedRequestTimeoutMs } from "./timeoutPolicy";

const CHANNEL_PATTERN = /^[a-zA-Z0-9_]{5,64}$/;

export type ChannelFailureKind = "channel_not_found" | "channel_private" | "network_error" | "structure_changed";

export interface ChannelValidationResult {
  ok: boolean;
  channel: string;
  kind: "available" | ChannelFailureKind;
  message: string;
}

function classifyBody(status: number, body: string): ChannelValidationResult["kind"] {
  const text = body.toLowerCase();
  if (status === 404 || status === 410 || /username not found|page doesn't exist|channel not found/.test(text)) return "channel_not_found";
  if (/private channel|join this channel|invite link|this channel is private/.test(text)) return "channel_private";
  if (!/tgme_page|tgme_widget_message|telegram/.test(text)) return "structure_changed";
  return "available";
}

/**
 * Validate a channel source through the persisted source template before it is
 * stored in the browser's user settings. Uses one real request so an
 * unreachable or non-public channel is rejected at add time.
 */
export async function validateChannelSource(channel: string, options: { signal?: AbortSignal } = {}): Promise<ChannelValidationResult> {
  const normalized = channel.trim().replace(/^@/, "").toLowerCase();
  if (!CHANNEL_PATTERN.test(normalized)) return { ok: false, channel: normalized, kind: "channel_not_found", message: "请输入有效的公开频道用户名。" };
  const source = buildSourceFromTemplate(normalized);
  const url = new URL(source.url);
  const headers = { ...(source.request.headers as Record<string, string> || {}) };
  try {
    const response = await executeSafeHttp({
      method: source.method,
      url: source.url,
      headers,
      body: source.method === "POST" && source.request.body !== undefined ? JSON.stringify(source.request.body) : undefined,
      signal: options.signal,
      timeoutMs: getUnifiedRequestTimeoutMs(),
      maxRequestBodyBytes: 64 * 1024,
      maxResponseBytes: typeof source.request.maxResponseBytes === "number" ? source.request.maxResponseBytes : 2 * 1024 * 1024,
      maxRedirects: 3,
      followRedirects: true,
      expectedContentTypes: ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"],
      allowedDomains: [url.hostname],
      allowHttp: false,
    });
    const kind = classifyBody(response.response.status, response.body);
    if (kind === "available") return { ok: true, channel: normalized, kind, message: "已确认这是可访问的公开频道。" };
    return { ok: false, channel: normalized, kind, message: kind === "channel_private" ? "这个频道不是公开频道，无法添加。" : "找不到这个公开频道，无法添加。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, channel: normalized, kind: "network_error", message: `频道验证失败：${message}` };
  }
}
