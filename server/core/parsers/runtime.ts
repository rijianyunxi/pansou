import { load, type CheerioAPI } from "cheerio";
import { Script, createContext } from "node:vm";
import { inferDriveType, validResourceUrl } from "../../../utils/upstreamAdapter";
import type { Link, SearchResult } from "../types/models";
import { formatSearchDateTime } from "../utils/searchDateTime";
import type { ParserExecutionContext, ParserPluginRecord } from "./types";
import { validateParserCode } from "./repository";

const MAX_OUTPUT = 500;
const MAX_NAME = 500;
const MAX_DESCRIPTION = 20_000;
const MAX_URL = 4_000;

function text(value: unknown, max = MAX_DESCRIPTION): string {
  return value == null ? "" : String(value).trim().slice(0, max);
}

function compact(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeLink(value: unknown): Link | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const url = text(input.url, MAX_URL);
  if (!url || !validResourceUrl(url)) return null;
  return {
    url,
    type: inferDriveType(url),
    password: text(input.password, 100) || null,
  };
}

function validateAndLimitResults(value: unknown, record: ParserPluginRecord, context: ParserExecutionContext): SearchResult[] {
  // Parser transforms have one output contract. Do not silently adapt the
  // removed title/content/url/items shape here: a source must return the same
  // resource-level fields that the public search API exposes.
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.min(MAX_OUTPUT, record.manifest.maxResults)).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>;
    if (typeof input.id !== "string" && typeof input.id !== "number") return [];
    if (typeof input.name !== "string") return [];
    if (!(typeof input.description === "string" || input.description === null)) return [];
    if (!(typeof input.datetime === "string" || input.datetime === null)) return [];
    if (!Array.isArray(input.cloud_types) || !input.cloud_types.length || input.cloud_types.some((type) => typeof type !== "string") || !Array.isArray(input.links)) return [];
    const links = input.links.map(normalizeLink).filter((link): link is Link => !!link);
    if (!links.length) return [];
    const id = text(input.id, 200) || `${context.channel || context.source || record.id}-${index}`;
    const description = text(input.description);
    const needle = compact(context.keyword);
    if (needle && !compact(`${input.name} ${description}`).includes(needle)) return [];
    const datetime = formatSearchDateTime(input.datetime as string | null);
    return [{
      id,
      name: text(input.name, MAX_NAME),
      description: description || null,
      datetime,
      cloud_types: [...new Set(links.map((link) => link.type))],
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
    throw new Error(`解析器 ${record.id} 当前未发布或已关闭`);
  }
  if (record.manifest.format !== "auto" && record.manifest.format !== context.format) {
    throw new Error(`解析器 ${record.id} 需要 ${record.manifest.format}，当前响应是 ${context.format}`);
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
  if (typeof transform !== "function") throw new Error("解析器必须返回一个函数");
  (sandbox as Record<string, unknown>).transform = transform;
  const result = new Script("transform(payload, $, context)", { filename: `parser-plugin:${record.id}:invoke` })
    .runInContext(sandbox, { timeout: record.manifest.timeoutMs });
  if (result && typeof result.then === "function") throw new Error("解析器必须是同步函数，不允许异步网络请求");
  return validateAndLimitResults(result, record, context);
}
