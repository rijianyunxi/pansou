import { load, type CheerioAPI } from "cheerio";
import { Script, createContext } from "node:vm";
import { inferDriveType, validResourceUrl } from "../../../utils/sourceAdapter";
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

function normalizeImages(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const images: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const rawText = text(raw, MAX_URL);
    const image = rawText.startsWith("//") ? `https:${rawText}` : rawText;
    // Image metadata is exposed directly to clients, so discard relative
    // paths, javascript URLs and other values that cannot be opened safely.
    if (!/^https?:\/\//iu.test(image) || seen.has(image)) continue;
    seen.add(image);
    images.push(image);
    if (images.length >= 10) break;
  }
  return images;
}

const IMAGE_FIELD = /^(?:image|images|img|pic|picture|pictures|photo|photos|poster|posters|cover|covers|thumbnail|thumbnails|thumb|vod_pic)(?:_?(?:url|src|thumb|original))?$/iu;

function imageUrlsFromValue(value: unknown, output: unknown[] = [], depth = 0): unknown[] {
  if (depth > 5 || output.length >= 20 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) imageUrlsFromValue(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") {
    output.push(value);
    return output;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (IMAGE_FIELD.test(key)) imageUrlsFromValue(item, output, depth + 1);
    else if (item && typeof item === "object") imageUrlsFromValue(item, output, depth + 1);
    if (output.length >= 20) break;
  }
  return output;
}

function valueContainsIdentity(value: unknown, result: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const identities = [result.id, result.name].map((item) => String(item ?? "").trim()).filter(Boolean);
  const candidates = [source.id, source.key, source.name, source.title, source.vod_id, source.vod_name, source.url];
  return identities.some((identity) => candidates.some((candidate) => String(candidate ?? "").trim() === identity));
}

function inferJsonImages(payload: unknown, result: Record<string, unknown>): string[] {
  const candidates: unknown[] = [];
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 6 || candidates.length >= 20 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (valueContainsIdentity(value, result)) imageUrlsFromValue(value, candidates);
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };
  walk(payload);
  return normalizeImages(candidates);
}

function inferHtmlImages($: CheerioAPI | undefined, result: Record<string, unknown>): string[] {
  if (!$) return [];
  const selectors = ".tgme_widget_message_wrap,.tgme_widget_message,article,li,tr";
  const candidates: unknown[] = [];
  const name = String(result.name || "").trim();
  const links = Array.isArray(result.links) ? result.links : [];
  $(selectors).each((_, element) => {
    if (candidates.length >= 20) return;
    const root = $(element);
    const markup = root.html() || "";
    const matched = (name && root.text().includes(name)) || links.some((link) => {
      const url = link && typeof link === "object" ? String((link as Record<string, unknown>).url || "") : "";
      return !!url && markup.includes(url);
    });
    if (!matched) return;
    root.find("img[src],img[data-src]").not(".tgme_widget_message_user_photo img,.tgme_widget_message_author_photo img,[class*='avatar'] img,[class*='avatar']").each((__, image) => {
      candidates.push($(image).attr("src") || $(image).attr("data-src"));
    });
    root.find("[style*='background-image']").not(".tgme_widget_message_user_photo,.tgme_widget_message_author_photo,[class*='avatar']").each((__, node) => {
      const style = String($(node).attr("style") || "");
      const match = style.match(/url\(\s*["']?([^"')]+)["']?\s*\)/iu);
      if (match) candidates.push(match[1]);
    });
  });
  return normalizeImages(candidates);
}

function compact(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeLink(value: unknown): Link | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return makeLink(input.url, input.password);
}

function makeLink(urlValue: unknown, passwordValue?: unknown): Link | null {
  const url = text(urlValue, MAX_URL);
  if (!url || !validResourceUrl(url)) return null;
  return {
    url,
    type: inferDriveType(url),
    password: text(passwordValue, 100) || null,
  };
}

function validateAndLimitResults(value: unknown, definition: SourceTransformDefinition, context: SourceTransformContext, payload: unknown, $?: CheerioAPI): SearchResult[] {
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
    if (!Array.isArray(input.links)) return [];
    const links = input.links.map(normalizeLink).filter((link): link is Link => !!link);
    if (!links.length) return [];
    const id = text(input.id, 200) || `${context.source || definition.id}-${index}`;
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
      ...(() => {
        const images = normalizeImages(input.images);
        const inferred = images.length ? images : context.format === "html"
          ? inferHtmlImages($, input)
          : inferJsonImages(payload, input);
        return inferred.length ? { images: inferred } : {};
      })(),
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
  const safeContext = Object.freeze({
    ...context,
    makeLink: (url: unknown, password?: unknown) => makeLink(url, password),
    inferDriveType: (url: string) => inferDriveType(text(url, MAX_URL)),
  });
  const sandbox = createContext({ payload, $, context: safeContext });
  const timeoutMs = getUnifiedRequestTimeoutMs();
  const createScript = new Script(createTransformSource(code), { filename: `transform:${definition.id}` });
  const transform = createScript.runInContext(sandbox, { timeout: timeoutMs });
  if (typeof transform !== "function") throw new Error("transform 必须返回一个函数");
  (sandbox as Record<string, unknown>).transform = transform;
  const result = new Script("transform(payload, $, context)", { filename: `transform:${definition.id}:invoke` })
    .runInContext(sandbox, { timeout: timeoutMs });
  if (result && typeof result.then === "function") throw new Error("transform 必须是同步函数，不允许异步网络请求");
  return validateAndLimitResults(result, definition, context, payload, $);
}
