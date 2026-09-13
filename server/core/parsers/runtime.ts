import { load, type CheerioAPI } from "cheerio";
import { Script, createContext } from "node:vm";
import { inferDriveType, validResourceUrl } from "../../../utils/upstreamAdapter";
import type { Link, SearchResult } from "../types/models";
import type { ParserExecutionContext, ParserPluginRecord } from "./types";
import { validateParserCode } from "./repository";

const MAX_OUTPUT = 500;
const MAX_TITLE = 500;
const MAX_CONTENT = 20_000;
const MAX_URL = 4_000;

function text(value: unknown, max = MAX_CONTENT): string {
  return value == null ? "" : String(value).trim().slice(0, max);
}

function normalizeLink(value: unknown): Link | null {
  if (typeof value === "string") value = { url: value };
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const url = text(input.url || input.href || input.link, MAX_URL);
  if (!url || !validResourceUrl(url)) return null;
  return {
    url,
    type: text(input.type, 80) || inferDriveType(url),
    password: text(input.password || input.pwd, 100),
  };
}

function normalizeResults(value: unknown, record: ParserPluginRecord, context: ParserExecutionContext): SearchResult[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return items.slice(0, Math.min(MAX_OUTPUT, record.manifest.maxResults)).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const input = item as Record<string, unknown>;
    const rawLinks = Array.isArray(input.links)
      ? input.links
      : [input.url || input.href || input.link].filter(Boolean);
    const links = rawLinks.map(normalizeLink).filter((link): link is Link => !!link);
    if (!links.length) return [];
    const unique = text(input.unique_id || input.uniqueId, 200) || `${context.channel || context.source || record.id}-${index}`;
    return [{
      message_id: text(input.message_id || input.messageId, 200),
      unique_id: unique,
      channel: text(input.channel, 200) || context.channel || context.source || record.id,
      datetime: text(input.datetime || input.date || input.time, 100),
      title: text(input.title || input.name, MAX_TITLE),
      content: text(input.content || input.description || input.desc),
      links,
      ...(Array.isArray(input.tags) ? { tags: input.tags.map((tag) => text(tag, 80)).filter(Boolean).slice(0, 20) } : {}),
      ...(Array.isArray(input.images) ? { images: input.images.map((image) => text(image, MAX_URL)).filter(Boolean).slice(0, 10) } : {}),
      source: "plugin",
      pluginId: record.id,
      pluginVersion: record.manifest.version,
    } satisfies SearchResult];
  });
}

function createTransformSource(code: string): string {
  const trimmed = code.trim();
  // Accept either `(payload, $, context) => items`, `function transform(...) {}`
  // or a function body for convenience in the admin editor.
  if (/^(?:async\s+)?function\b/.test(trimmed) || trimmed.includes("=>")) return `(${trimmed})`;
  return `(function(payload, $, context) {\n${trimmed}\n})`;
}

export function parseWithParserPlugin(
  record: ParserPluginRecord,
  rawBody: string,
  context: ParserExecutionContext,
  options: { allowUnpublished?: boolean } = {},
): SearchResult[] {
  validateParserCode(record.code);
  if (record.status !== "published" && !(options.allowUnpublished && record.status !== "archived")) {
    throw new Error(`解析插件 ${record.id} 当前未发布或已停用`);
  }
  if (record.manifest.format !== "auto" && record.manifest.format !== context.format) {
    throw new Error(`解析插件 ${record.id} 需要 ${record.manifest.format}，当前响应是 ${context.format}`);
  }
  // auto lets one TG/channel plugin handle both Telegram HTML and Jina
  // Markdown. The transform still receives the actual format in context.
  const payload = context.format === "json" ? JSON.parse(rawBody) : rawBody;
  const $: CheerioAPI | undefined = context.format === "html" ? load(rawBody) : undefined;
  const safeContext = Object.freeze({ ...context });
  // Invoke the transform inside the VM as well. Calling a VM-created function
  // from the host would bypass vm.Script's timeout and make `while (true)` a
  // process-blocking denial of service.
  const sandbox = createContext({ payload, $, context: safeContext });
  const createScript = new Script(createTransformSource(record.code), { filename: `parser-plugin:${record.id}` });
  const transform = createScript.runInContext(sandbox, { timeout: record.manifest.timeoutMs });
  if (typeof transform !== "function") throw new Error("解析插件必须返回一个函数");
  (sandbox as Record<string, unknown>).transform = transform;
  const result = new Script("transform(payload, $, context)", { filename: `parser-plugin:${record.id}:invoke` })
    .runInContext(sandbox, { timeout: record.manifest.timeoutMs });
  if (result && typeof result.then === "function") throw new Error("解析插件必须是同步函数，不允许异步网络请求");
  return normalizeResults(result, record, context);
}
