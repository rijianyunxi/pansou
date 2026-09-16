/** Built-in parser used for user-supplied Telegram channels and as the initial value for managed sources. */
export const DEFAULT_CHANNEL_TRANSFORM = String.raw`function transform(payload, $, context) {
  const keyword = String(context.keyword || "").trim().toLowerCase();
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const needle = normalize(keyword);
  const matches = (value) => !needle || normalize(value).includes(needle);
  const cloudTypeOf = (value) => {
    const url = String(value || "").toLowerCase();
    if (/^magnet:/.test(url)) return "magnet";
    const host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
    const pairs = [["pan.baidu.com", "baidu"], ["pan.quark.cn", "quark"], ["aliyundrive.com", "aliyun"], ["alipan.com", "aliyun"], ["yun.139.com", "mobile"], ["cloud.189.cn", "tianyi"], ["115.com", "115"], ["123pan.com", "123"], ["123pan.cn", "123"], ["123684.com", "123"], ["123865.com", "123"], ["drive.uc.cn", "others"], ["jianguoyun.com", "jianguoyun"], ["pan.xunlei.com", "xunlei"]];
    const pair = pairs.find((entry) => host === entry[0] || host.endsWith("." + entry[0]));
    return pair ? pair[1] : /(^|\.)lanzou[a-z0-9-]*\.com$/.test(host) ? "lanzou" : "others";
  };
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
  const passwordOf = (value) => String(value || "").match(/(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,8})/i)?.[1] || "";
  const isResource = (value) => {
    const url = String(value || "").trim();
    return /^(?:magnet:\?[^\s<>"')\]]+|https?:\/\/(?![^/]*@)(?!t\.me(?:[/:]|$))(?:[^/]+\.)?(?:pan\.baidu\.com|pan\.quark\.cn|alipan\.com|aliyundrive\.com|cloud\.189\.cn|123pan\.(?:com|cn)|123684\.com|123865\.com|drive\.uc\.cn|115\.com|jianguoyun\.com|yun\.139\.com|pan\.xunlei\.com|lanzou\w*\.com)(?:[/:]|$)[^\s<>"')\]]+)$/i.test(url);
  };
  const linksOf = (value, hrefs) => {
    const links = [];
    const seen = new Set();
    const add = (raw) => {
      const url = String(raw || "").trim().replace(/[#\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").replace(/[，。！？；：、）》】]+$/u, "");
      if (!isResource(url) || seen.has(url)) return;
      seen.add(url);
      links.push({ type: cloudTypeOf(url), url, password: passwordOf(value) || null });
    };
    for (const url of String(value || "").match(/(?:https?:\/\/|magnet:\?)[^\s<>"')\]]+/gi) || []) add(url);
    for (const url of hrefs || []) add(url);
    return links;
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
      const content = clean(text);
      const hrefs = root.find(".tgme_widget_message_text a[href]").map((_, link) => $(link).attr("href") || "").get();
      const links = linksOf(text, hrefs);
      const postId = root.find(".tgme_widget_message").attr("data-post") || "";
      const datetime = root.find("time").attr("datetime") || "";
      if (title && matches(text) && links.length) output.push({ id: String(context.source || "source") + "-" + (postId || index), name: title, description: content, datetime, cloud_types: [...new Set(links.map((link) => link.type))], links });
    });
  }
  return output;
}`;
