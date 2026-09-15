import { load, type CheerioAPI } from "cheerio";
import { Script, createContext } from "node:vm";
import { inferDriveType, validResourceUrl } from "../../../utils/upstreamAdapter";
import type { Link, SearchResult } from "../types/models";
import { formatSearchDateTime } from "../utils/searchDateTime";
import type { SourceTransformDefinition, SourceTransformContext } from "./types";
import { validateSourceTransformCode } from "./validation";
import { getUnifiedRequestTimeoutMs } from "../services/timeoutPolicy";

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

function validateAndLimitResults(value: unknown, definition: SourceTransformDefinition, context: SourceTransformContext): SearchResult[] {
  // Transforms have one output contract. A source must return the same
  // resource-level fields that the public search API exposes.
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.min(MAX_OUTPUT, definition.maxResults)).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>;
    if (typeof input.id !== "string" && typeof input.id !== "number") return [];
    if (typeof input.name !== "string") return [];
    if (!(typeof input.description === "string" || input.description === null)) return [];
    if (!(typeof input.datetime === "string" || input.datetime === null)) return [];
    if (!Array.isArray(input.cloud_types) || !input.cloud_types.length || input.cloud_types.some((type) => typeof type !== "string") || !Array.isArray(input.links)) return [];
    const links = input.links.map(normalizeLink).filter((link): link is Link => !!link);
    if (!links.length) return [];
    const id = text(input.id, 200) || `${context.channel || context.source || definition.id}-${index}`;
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
      pluginId: definition.id,
      pluginVersion: definition.version,
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

export function executeSourceTransform(
  definition: SourceTransformDefinition,
  rawBody: string,
  context: SourceTransformContext,
): SearchResult[] {
  const code = validateSourceTransformCode(definition.code);
  if (definition.format !== "auto" && definition.format !== context.format) {
    throw new Error(`解析函数 ${definition.id} 需要 ${definition.format}，当前响应是 ${context.format}`);
  }
  const payload = context.format === "json" ? JSON.parse(rawBody) : rawBody;
  const $: CheerioAPI | undefined = context.format === "html" ? load(rawBody) : undefined;
  const safeContext = Object.freeze({ ...context });
  const sandbox = createContext({ payload, $, context: safeContext });
  const timeoutMs = getUnifiedRequestTimeoutMs();
  const createScript = new Script(createTransformSource(code), { filename: `transform:${definition.id}` });
  const transform = createScript.runInContext(sandbox, { timeout: timeoutMs });
  if (typeof transform !== "function") throw new Error("transform 必须返回一个函数");
  (sandbox as Record<string, unknown>).transform = transform;
  const result = new Script("transform(payload, $, context)", { filename: `transform:${definition.id}:invoke` })
    .runInContext(sandbox, { timeout: timeoutMs });
  if (result && typeof result.then === "function") throw new Error("transform 必须是同步函数，不允许异步网络请求");
  return validateAndLimitResults(result, definition, context);
}
