/** Built-in parser used for user-supplied Telegram channels and as the initial value for managed sources. */
export const TELEGRAM_DEFAULT_TRANSFORM = String.raw`function transform(payload, $, context) {
  const keyword = String(context.keyword || "").trim().toLowerCase();
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const needle = normalize(keyword);
  const matches = (value) => !needle || normalize(value).includes(needle);
  const cloudTypeOf = (value) => {
    const url = String(value || "").toLowerCase();
    if (/^magnet:/.test(url)) return "magnet";
    const host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
    const pairs = [["pan.baidu.com", "baidu"], ["pan.quark.cn", "quark"], ["aliyundrive.com", "aliyun"], ["alipan.com", "aliyun"], ["yun.139.com", "mobile"], ["cloud.189.cn", "tianyi"], ["115.com", "115"], ["123pan.com", "123"], ["jianguoyun.com", "jianguoyun"], ["pan.xunlei.com", "xunlei"]];
    const pair = pairs.find((entry) => host === entry[0] || host.endsWith("." + entry[0]));
    return pair ? pair[1] : /(^|\.)lanzou[a-z0-9-]*\.com$/.test(host) ? "lanzou" : "others";
  };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const passwordOf = (value) => String(value || "").match(/(?:提取码|密码|pwd|pass)[:：\s]*([a-zA-Z0-9]{3,8})/i)?.[1] || "";
  const isResource = (value) => {
    const url = String(value || "").trim();
    return /^(?:magnet:\?[^\s<>"')\]]+|https?:\/\/(?![^/]*@)(?!t\.me(?:[/:]|$))(?!r\.jina\.ai(?:[/:]|$))(?:[^/]+\.)?(?:pan\.baidu\.com|pan\.quark\.cn|alipan\.com|aliyundrive\.com|cloud\.189\.cn|123pan\.com|115\.com|jianguoyun\.com|yun\.139\.com|pan\.xunlei\.com|lanzou\w*\.com)(?:[/:]|$)[^\s<>"')\]]+)$/i.test(url);
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
  if (context.format === "html" && $ && (context.route !== "jina" || /tgme_widget_message/.test(String(payload || "")))) {
    $(".tgme_widget_message_wrap").each((index, element) => {
      const root = $(element);
      const text = root.find(".tgme_widget_message_text").text().trim();
      const title = clean(text.split(/\n/)[0] || text).slice(0, 500);
      const content = clean(text);
      const hrefs = root.find(".tgme_widget_message_text a[href]").map((_, link) => $(link).attr("href") || "").get();
      const links = linksOf(text, hrefs);
      const postId = root.find(".tgme_widget_message").attr("data-post") || "";
      const datetime = root.find("time").attr("datetime") || "";
      if (matches(text) && links.length) output.push({ id: "tg-" + (context.channel || "channel") + "-" + (postId || index), name: title, description: content, datetime, cloud_types: [...new Set(links.map((link) => link.type))], links });
    });
  } else {
    const source = String(payload || "");
    const start = source.search(/^Markdown Content:\s*$/im);
    const content = start >= 0 ? source.slice(source.indexOf("\n", start) + 1) : source;
    const markers = [...content.matchAll(/\[\]\(\s*(https?:\/\/(?:www\.)?t\.me\/(?:s\/)?[^\s/)]+\/(\d+)(?:\?[^)]*)?)\s*\)/gi)];
    markers.forEach((marker, index) => {
      const markerText = marker[0];
      const blockStart = (marker.index || 0) + markerText.length;
      const blockEnd = markers[index + 1]?.index || content.length;
      const block = content.slice(blockStart, blockEnd).trim();
      const title = clean(block.split(/\n/).find((line) => line.trim()) || "").slice(0, 500);
      const hrefs = [...block.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi)].map((item) => item[1]);
      const links = linksOf(block, hrefs);
      const postId = marker[2] || "";
      if (matches(block) && links.length) output.push({ id: "tg-" + (context.channel || "channel") + "-" + postId, name: title, description: clean(block), datetime: "", cloud_types: [...new Set(links.map((link) => link.type))], links });
    });
  }
  return output;
}`;

