export interface TgSourceUrlSettings {
  directTemplate?: string;
  jinaTemplate?: string;
}

export const DEFAULT_TG_SOURCE_URLS: Required<TgSourceUrlSettings> = {
  directTemplate: "https://t.me/s/{{channel}}",
  jinaTemplate: "https://r.jina.ai/https://t.me/s/{{channel}}",
};

/** Build the browser-visible URL from the same templates used by the server. */
export function buildTgSourceUrl(
  route: "direct" | "jina",
  channel: string,
  keyword = "",
  before?: string,
  settings: TgSourceUrlSettings = {},
): string {
  const template = route === "jina"
    ? settings.jinaTemplate || DEFAULT_TG_SOURCE_URLS.jinaTemplate
    : settings.directTemplate || DEFAULT_TG_SOURCE_URLS.directTemplate;
  const normalizedChannel = channel.trim().replace(/^@/, "");
  const filled = template
    .replaceAll("{{channel}}", encodeURIComponent(normalizedChannel))
    .replaceAll("{{keyword}}", encodeURIComponent(keyword.trim()))
    .replaceAll("{{before}}", encodeURIComponent(before || ""));
  const url = new URL(filled);
  if (keyword.trim()) url.searchParams.set("q", keyword.trim());
  else url.searchParams.delete("q");
  if (before) url.searchParams.set("before", before);
  else url.searchParams.delete("before");
  return url.toString();
}
