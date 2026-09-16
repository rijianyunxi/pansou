export default function transform(payload, $, context) {
  var keyword = String(context.keyword || "").trim().toLowerCase();
  var compact = function (value) { return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); };
  var needle = compact(keyword);
  var matches = function (value) { return !needle || compact(value).indexOf(needle) >= 0; };
  var clean = function (value) {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/https?:\/\/[^\s"'<>]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  var trimUrl = function (value) {
    return String(value || "").trim().replace(/[，。！？；：、）》】]+$/g, "");
  };
  var cloudTypeOf = function (value) {
    var url = String(value || "").toLowerCase();
    if (/^magnet:/.test(url)) return "magnet";
    var host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
    var pairs = [["pan.baidu.com", "baidu"], ["pan.quark.cn", "quark"], ["aliyundrive.com", "aliyun"], ["alipan.com", "aliyun"], ["yun.139.com", "mobile"], ["cloud.189.cn", "tianyi"], ["115.com", "115"], ["123pan.com", "123"], ["jianguoyun.com", "jianguoyun"], ["pan.xunlei.com", "xunlei"]];
    var pair = pairs.find(function (entry) { return host === entry[0] || host.endsWith("." + entry[0]); });
    return pair ? pair[1] : /(^|\.)lanzou[a-z0-9-]*\.com$/.test(host) ? "lanzou" : "others";
  };
  var linkOf = function (url) {
    var normalized = trimUrl(url);
    return { type: cloudTypeOf(normalized), url: normalized, password: null };
  };
  var urlsOf = function (raw) {
    var urls = [], seen = [];
    var add = function (value) {
      var normalized = trimUrl(value);
      if (!normalized || /(?:yiso\.eu\.org|pansearch\.me)/i.test(normalized)) return;
      if (seen.indexOf(normalized) >= 0) return;
      seen.push(normalized);
      urls.push(normalized);
    };
    var hrefs = String(raw || "").matchAll(/href\s*=\s*["']([^"']+)["']/gi);
    for (var href of hrefs) add(href[1]);
    if (!urls.length) {
      var plain = String(raw || "").match(/(?:https?|magnet):\/\/[^\s"'<>]+/gi) || [];
      plain.forEach(add);
    }
    return urls;
  };
  var descriptionOf = function (block, name) {
    var text = clean(String(block || "").replace(/更多精彩资源[\s\S]*$/g, "").replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " "));
    text = text.replace(/^\s*\d+\s*[、.．]\s*/, "");
    if (name && text.indexOf(name) === 0) text = text.slice(name.length);
    text = text.replace(/^[\s:：;；]+/, "").trim();
    return text || null;
  };
  var parseNumbered = function (raw, item, index) {
    var entries = [], entryMatch;
    var entryRe = /(?:^|\n)\s*\d+\s*[、.．]\s*[\s\S]*?(?=(?:\n\s*\d+\s*[、.．])|$)/g;
    while ((entryMatch = entryRe.exec(raw)) !== null) entries.push(entryMatch[0]);
    return entries.map(function (block, entryIndex) {
      var firstAnchor = block.search(/<a\b/i);
      var firstUrl = block.search(/(?:https?|magnet):\/\//i);
      var end = firstAnchor >= 0 ? firstAnchor : (firstUrl >= 0 ? firstUrl : block.length);
      var head = block.slice(0, end).replace(/^\s*\d+\s*[、.．]\s*/, "").replace(/\s*[:：]\s*$/, "");
      var name = clean(head);
      var urls = urlsOf(block);
      var links = urls.map(linkOf).filter(function (link) { return link.url && link.type !== "others"; });
      if (!name || !links.length || !matches(name + " " + clean(block))) return null;
      return {
        id: String((item && item.id) || context.source || "pansearch") + "-" + index + "-" + entryIndex,
        name: name,
        description: descriptionOf(block, name),
        datetime: String((item && item.time) || "") || null,
        cloud_types: links.map(function (link) { return link.type; }).filter(function (type, typeIndex, all) { return all.indexOf(type) === typeIndex; }),
        links: links
      };
    }).filter(function (item) { return item !== null; });
  };
  var list = payload && payload.indexOf ? (function () {
    var marker = '<script id="__NEXT_DATA__"';
    var markerIndex = payload.indexOf(marker);
    var start = markerIndex >= 0 ? payload.indexOf('>', markerIndex) + 1 : -1;
    var end = start > 0 ? payload.indexOf('</script>', start) : -1;
    var nextData = start > 0 && end > start ? payload.slice(start, end) : '';
    try {
      var parsed = nextData ? JSON.parse(nextData) : {};
      return parsed && parsed.props && parsed.props.pageProps && parsed.props.pageProps.data && Array.isArray(parsed.props.pageProps.data.data) ? parsed.props.pageProps.data.data : [];
    } catch (error) { return []; }
  }()) : [];
  return list.flatMap(function (item, index) {
    var raw = String((item && item.content) || "");
    var named = raw.match(/(?:^|\n)\s*名称：([\s\S]*?)(?:\n\s*描述：|\n\s*链接：|$)/);
    if (!named && /(?:^|\n)\s*\d+\s*[、.．]/.test(raw)) return parseNumbered(raw, item, index);
    var descriptionMatch = raw.match(/(?:^|\n)\s*描述：([\s\S]*?)(?:\n\s*链接：|$)/);
    var urls = urlsOf(raw);
    var links = urls.map(linkOf).filter(function (link) { return link.url && link.type !== "others"; });
    var name = clean(named ? named[1] : raw.split(/\n/)[0]);
    var description = clean(descriptionMatch ? descriptionMatch[1] : "");
    if (!name || !links.length || !matches(name + " " + description + " " + raw)) return [];
    return [{
      id: String((item && item.id) || context.source + "-" + index),
      name: name,
      description: description || null,
      datetime: String((item && item.time) || "") || null,
      cloud_types: links.map(function (link) { return link.type; }).filter(function (type, typeIndex, all) { return all.indexOf(type) === typeIndex; }),
      links: links
    }];
  });
}
