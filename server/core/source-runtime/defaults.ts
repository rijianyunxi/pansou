/** Built-in parser used for user-supplied channels and as the initial value for managed sources. */
export const DEFAULT_CHANNEL_TRANSFORM = String.raw`function transform(payload, $, context) {
  const keyword = String(context.keyword || "").trim().toLowerCase();
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const needle = normalize(keyword);
  const matches = (value) => !needle || normalize(value).includes(needle);
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  // Preserve structural lines before normalizing whitespace. Telegram renders
  // most message newlines as <br>, which Cheerio .text() silently discards.
  const plain = (value) => String(value || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|\x60/g, "");
  const undecorate = (value) => clean(plain(value))
    .replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200D🎭⭐◎#>*•·]+/gu, "").trim();
  const titleOf = (value) => {
    const lines = String(value || "").split(/\r?\n/).map(undecorate).filter(Boolean);
    const label = /^(?:【|\[)?(?:资源名称|资源标题|影片名称|电影名称|剧集名称|电视剧名|电影名|剧名|名称|标题|译\s*名|片\s*名|资源名)(?:】|\])?\s*(?:[:：]\s*|\s+)/;
    const finish = (line) => undecorate(line).split(/https?:\/\/|magnet:\?/i)[0].replace(/[\s|｜,，;；:：-]+$/g, "").trim().slice(0, 500);
    const boundary = /\s*(?:描述|简介|剧情简介|链接|下载链接|资源链接|类型|大小|提取码)\s*[:：]/;
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      const title = lines[i].replace(label, "").split(boundary)[0].trim();
      if (title) return finish(title);
      if (lines[i + 1] && !boundary.test(lines[i + 1])) return finish(lines[i + 1]);
    }
    const metadata = /^(?:描述|简介|剧情|链接|下载|资源链接|类型|标签|大小|画质|视频|字幕|分享|评分|TMDB|豆瓣|提取码|密码|频道|订阅|https?:|magnet:|\[?图片|Image\s*\d)/i;
    return finish((lines.find((line) => !metadata.test(line)) || "").split(boundary)[0]);
  };
  // Keep only the human-readable synopsis in the description field. Resource posts
  // commonly put the title, synopsis, drive links, size, tags and channel
  // promotion in one line after Telegram removes the original line breaks.
  const descriptionOf = (value, title, allowFallback) => {
    let source = String(value || "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, " ")
      .replace(/\*\*|__|\x60/g, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/(?:https?:\/\/|magnet:\?)[^\s<>"')\]]+/gi, " ")
      .replace(/\r/g, "");
    const label = /(?:^|[\s\p{Extended_Pictographic}\uFE0F\u200D])(?:【|\[)?(?:资源描述|资源简介|剧情简介|内容简介|描述|简介|剧情介绍|摘要|介绍)(?:】|\])?\s*[:：]\s*/iu;
    const found = source.match(label);
    if (found) source = source.slice((found.index || 0) + found[0].length);
    else if (!allowFallback) return null;
    if (!found && title) {
      const titleText = undecorate(title);
      const titleIndex = titleText ? source.indexOf(titleText) : -1;
      if (titleIndex >= 0) source = source.slice(titleIndex + titleText.length);
    }
    const stop = /(?:阿里(?:云盘)?|阿里|夸克(?:网盘)?|百度(?:网盘)?|光鸭(?:云盘)?|迅雷(?:云盘)?|115(?:网盘)?|UC(?:网盘)?|天翼云盘|移动云盘|坚果云|蓝奏云|123网盘|网盘|下载地址|下载链接|资源链接|链接|提取码|密码|文件大小|大小|资源类型|类型|资源标签|标签|来源|来自|频道|群组|机器人|订阅|更新时间|上映|导演|主演|制片|评分|豆瓣|TMDB|画质|视频|字幕|分享)\s*[:：]|(?:👇|🔗|📁|📂|🏷|📢|🤖|🙍|👥)/i;
    const boundary = source.search(stop);
    if (boundary >= 0) source = source.slice(0, boundary);
    source = source.replace(/^[\s:：;；|｜,，]+/, "").replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").trim();
    return clean(source).replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").trim() || null;
  };
  const passwordOf = (value) => String(value || "").match(/(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,8})/i)?.[1] || "";
  const isResource = (value) => {
    const url = String(value || "").trim();
    return /^(?:magnet:\?[^\s<>"')\]]+|https?:\/\/(?![^/]*@)(?!t\.me(?:[/:]|$))(?:[^/]+\.)?(?:pan\.baidu\.com|pan\.quark\.cn|guangyapan\.com|alipan\.com|aliyundrive\.com|cloud\.189\.cn|123pan\.(?:com|cn)|123684\.com|123865\.com|drive\.uc\.cn|115\.com|jianguoyun\.com|yun\.139\.com|pan\.xunlei\.com|lanzou\w*\.com)(?:[/:]|$)[^\s<>"')\]]+)$/i.test(url);
  };
  const linksOf = (value, hrefs) => {
    const links = [];
    const seen = new Set();
    const add = (raw) => {
      const url = String(raw || "").trim().replace(/[#\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").replace(/[，。！？；：、）》】]+$/u, "");
      if (!isResource(url)) return;
      const link = context.makeLink(url, passwordOf(value) || null);
      if (!link || seen.has(link.url)) return;
      seen.add(link.url);
      links.push(link);
    };
    for (const url of String(value || "").match(/(?:https?:\/\/|magnet:\?)[^\s<>"')\]]+/gi) || []) add(url);
    for (const url of hrefs || []) add(url);
    return links;
  };
  const imagesOf = (root) => {
    const images = [];
    const seen = new Set();
    const add = (raw) => {
      const image = String(raw || "").trim();
      if (!/^https?:\/\//i.test(image) || seen.has(image)) return;
      seen.add(image);
      images.push(image);
    };
    root.find("img[src], img[data-src]").not(".tgme_widget_message_user_photo img, .tgme_widget_message_author_photo img, [class*='avatar'] img, [class*='avatar']").each((_, image) => {
      add($(image).attr("src") || $(image).attr("data-src"));
    });
    root.find("[style*='background-image']").not(".tgme_widget_message_user_photo, .tgme_widget_message_author_photo, [class*='avatar']").each((_, element) => {
      const style = String($(element).attr("style") || "");
      const match = style.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (match) add(match[1]);
    });
    return images.slice(0, 10);
  };
  const output = [];
  if (context.format === "html" && $) {
    $(".tgme_widget_message_wrap").each((index, element) => {
      const root = $(element);
      const message = root.find(".tgme_widget_message_text").clone();
      message.find("br").replaceWith("\n");
      message.find("p, div, blockquote").append("\n");
      const text = message.text().trim();
      const title = titleOf(text);
      const content = descriptionOf(text, title, false);
      const hrefs = root.find(".tgme_widget_message_text a[href]").map((_, link) => $(link).attr("href") || "").get();
      const links = linksOf(text, hrefs);
      const images = imagesOf(root);
      const postId = root.find(".tgme_widget_message").attr("data-post") || "";
      const datetime = root.find("time").attr("datetime") || "";
      if (title && matches(text) && links.length) output.push({ id: String(context.source || "source") + "-" + (postId || index), name: title, description: content, datetime, links, ...(images.length ? { images } : {}) });
    });
  }
  return output;
}`;
