/**
 * /telegram 诊断增强（todo.md M6）的前端工具：
 * - 剪贴板复制（http 非安全环境降级提示）；
 * - 简单自实现 HTML 缩进美化（不引入第三方依赖）；
 * - 原始报文高亮（命中消息节点、搜索关键词、网盘/磁力链接）；
 * - stages 耗时对比与 failureKind 可读文案。
 * 仅供诊断 UI 使用，不包含服务端逻辑。
 */

export type TgFailureKind =
  | "channel_not_found"
  | "channel_private"
  | "network_error"
  | "structure_changed"
  | "no_results";

const FAILURE_LABELS: Record<TgFailureKind, string> = {
  channel_not_found: "频道不存在",
  channel_private: "频道私有",
  network_error: "网络失败",
  structure_changed: "页面结构变化",
  no_results: "关键词无结果",
};

const FAILURE_DETAILS: Record<TgFailureKind, string> = {
  channel_not_found: "Telegram 返回了联系页：该用户名没有公开预览页。",
  channel_private: "频道为私有或仅提供邀请链接，公开预览无法抓取。",
  network_error: "请求未能完成（超时、断网或连接被拒绝）。",
  structure_changed: "已取得页面，但未识别出公开消息结构，页面可能已改版。",
  no_results: "频道可访问，但当前关键词没有提取到网盘链接。",
};

export function failureKindLabel(kind?: string | null): string {
  if (!kind) return "";
  return FAILURE_LABELS[kind as TgFailureKind] ?? kind;
}

export function failureKindDetail(kind?: string | null): string {
  if (!kind) return "";
  return FAILURE_DETAILS[kind as TgFailureKind] ?? "未知失败类别。";
}

/** failureKind 对应的提示色调：bad=红 / warn=琥珀 / info=蓝。 */
export function failureKindTone(kind?: string | null): "bad" | "warn" | "info" {
  if (kind === "network_error") return "bad";
  if (kind === "no_results") return "info";
  return "warn";
}

/* ------------------------------------------------------------------ */
/* 剪贴板复制                                                          */
/* ------------------------------------------------------------------ */

export interface ClipboardCopyResult {
  ok: boolean;
  method: "clipboard-api" | "exec-command" | "none";
  message: string;
}

/**
 * 复制文本到剪贴板：优先 Clipboard API（需要 https/localhost 等安全上下文），
 * 不可用时降级到 execCommand；http 环境在返回信息里给出手动复制的降级提示。
 */
export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  if (!text) return { ok: false, method: "none", message: "内容为空，未复制。" };
  const secure = typeof window === "undefined" || window.isSecureContext !== false;
  if (secure && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard-api", message: "已复制到剪贴板。" };
    } catch {
      // 授权被拒或实现异常时降级到 execCommand。
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    textarea.remove();
    if (ok) {
      return {
        ok: true,
        method: "exec-command",
        message: secure
          ? "已复制到剪贴板。"
          : "已通过兼容方式复制；当前为 http 环境，如未成功请手动选择文本复制。",
      };
    }
  } catch {
    // ignore and fall through
  }
  return {
    ok: false,
    method: "none",
    message: secure
      ? "复制失败，请手动选择文本复制。"
      : "当前为 http 非安全环境，浏览器限制了剪贴板访问，请手动选择文本复制。",
  };
}

/* ------------------------------------------------------------------ */
/* HTML 美化（简单自实现缩进，不引入依赖）                              */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * 简单缩进美化：按注释 / DOCTYPE / 标签 / 文本分词，
 * 非自闭合的常规标签深度 +1，闭合前 -1，纯文本压成单行。仅供诊断阅读。
 */
export function formatHtmlPretty(html: string): string {
  if (!html) return "";
  const tokens = html.match(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/gi) ?? [];
  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      const text = token.replace(/\s+/g, " ").trim();
      if (text) lines.push("  ".repeat(depth) + text);
      continue;
    }
    if (token.startsWith("</")) {
      depth = Math.max(0, depth - 1);
      lines.push("  ".repeat(depth) + token);
      continue;
    }
    if (token.startsWith("<!")) {
      // 注释与 DOCTYPE 不改变缩进深度。
      lines.push("  ".repeat(depth) + token);
      continue;
    }
    lines.push("  ".repeat(depth) + token);
    const tag = /^<\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(token)?.[1]?.toLowerCase() ?? "";
    const selfClosed = /\/\s*>$/.test(token);
    if (!selfClosed && !VOID_TAGS.has(tag)) depth += 1;
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 高亮：消息节点 / 关键词 / 网盘与磁力链接                              */
/* ------------------------------------------------------------------ */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 网盘 / 磁力链接特征，与服务端 Telegram transform 的网盘主机名口径一致
 * （pan.baidu.com、pan.quark.cn、aliyundrive/alipan、yun.139.com、cloud.189.cn、115、123pan、jianguoyun、pan.xunlei.com、lanzou）。
 * 主机名必须紧跟在 `//`（scheme 后）或某个子域标签之后，且后面不能继续接
 * 域名字符，避免把 "x115.com"、"115.com.evil.com" 这类无关域名误判。
 */
const NETDISK_HOSTS =
  "(?:pan\\.baidu\\.com|pan\\.quark\\.cn|aliyundrive\\.com|alipan\\.com|yun\\.139\\.com|cloud\\.189\\.cn|115\\.com|123pan\\.com|jianguoyun\\.com|pan\\.xunlei\\.com|lanzou\\w*\\.com)";
const URL_TAIL = "[A-Za-z0-9._~:/?#[\\]@!$&'()*+,;=%-]*";
const LINK_SOURCE =
  `magnet:\\?[^\\s"'<>]+|ed2k://\\|file\\||https?://(?:[A-Za-z0-9-]+\\.)*${NETDISK_HOSTS}(?![A-Za-z0-9.-])${URL_TAIL}`;

export interface TgHighlightOptions {
  keyword?: string;
}

export interface TgHighlightStats {
  links: number;
  nodes: number;
  keywords: number;
}

function buildHighlightRegex(keyword?: string): RegExp | null {
  const parts: string[] = [
    `(?<link>${LINK_SOURCE})`,
    `(?<msg>tgme_widget_message(?:_[A-Za-z0-9]+)*)`,
  ];
  const kw = (keyword ?? "").trim();
  if (kw) parts.push(`(?<kw>${escapeRegExp(kw)})`);
  return new RegExp(parts.join("|"), "gi");
}

export interface TgHighlightResult {
  /** 可安全用于 v-html 的片段：全部内容已转义，仅插入自有 <mark> 标签。 */
  html: string;
  stats: TgHighlightStats;
}

/**
 * 把报文文本渲染成带高亮标记的 HTML。
 * 先用组合正则在原始文本上扫描命中区间，逐段转义后再包 <mark>，
 * 因此任何脚本内容都不会被原样输出。
 */
export function renderHighlightedHtml(source: string, options: TgHighlightOptions = {}): TgHighlightResult {
  const stats: TgHighlightStats = { links: 0, nodes: 0, keywords: 0 };
  if (!source) return { html: "", stats };
  const regex = buildHighlightRegex(options.keyword);
  if (!regex) return { html: escapeHtml(source), stats };
  const out: string[] = [];
  let last = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    if (!match[0].length) {
      regex.lastIndex += 1;
      continue;
    }
    out.push(escapeHtml(source.slice(last, match.index)));
    const kind = match.groups?.link ? "link" : match.groups?.msg ? "node" : "keyword";
    if (kind === "link") stats.links += 1;
    else if (kind === "node") stats.nodes += 1;
    else stats.keywords += 1;
    out.push(`<mark class="tg-hit-${kind}">${escapeHtml(match[0])}</mark>`);
    last = match.index + match[0].length;
  }
  out.push(escapeHtml(source.slice(last)));
  return { html: out.join(""), stats };
}
