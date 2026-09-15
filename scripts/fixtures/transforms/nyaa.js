export default function transform(payload, $, context) {
  if (!$) return [];
  var keyword = String(context.keyword || "").trim().toLowerCase();
  var compact = function (value) { return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); };
  var needle = compact(keyword);
  var matches = function (value) { return !needle || compact(value).indexOf(needle) >= 0; };
  var dateOf = function (value) {
    var raw = String(value || "").trim(); if (!raw) return null;
    var number = Number(raw); if (isFinite(number) && number > 1000000000) return new Date(number < 100000000000 ? number * 1000 : number).toISOString();
    var date = new Date(raw); return isNaN(date.getTime()) ? null : date.toISOString();
  };
  var cloudTypeOf = function (value) {
    var url = String(value || "").toLowerCase();
    if (/^magnet:/.test(url)) return "magnet";
    var host = url.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
    var pairs = [["pan.baidu.com", "baidu"], ["pan.quark.cn", "quark"], ["aliyundrive.com", "aliyun"], ["alipan.com", "aliyun"], ["yun.139.com", "mobile"], ["cloud.189.cn", "tianyi"], ["115.com", "115"], ["123pan.com", "123"], ["jianguoyun.com", "jianguoyun"], ["pan.xunlei.com", "xunlei"]];
    var pair = pairs.find(function (entry) { return host === entry[0] || host.endsWith("." + entry[0]); });
    return pair ? pair[1] : /(^|\.)lanzou[a-z0-9-]*\.com$/.test(host) ? "lanzou" : "others";
  };
  var decodeMagnetName = function (url) {
    var match = String(url || "").match(/[?&]dn=([^&]*)/i);
    if (!match) return "";
    try { return decodeURIComponent(match[1].replace(/\+/g, " ")).trim(); } catch (_) { return match[1].trim(); }
  };
  var linkOf = function (url, password) { return { type: cloudTypeOf(url), url: url, password: password || null }; };
  return $("table.torrent-list tbody tr").toArray().map(function (row, index) {
    var item = $(row);
    var titleAnchor = item.find("a[href^=\"/view/\"]").filter(function () {
      var anchor = $(this);
      var href = String(anchor.attr("href") || "");
      return !anchor.hasClass("comments") && !/#comments(?:$|[?#])/.test(href);
    }).first();
    var title = String(titleAnchor.attr("title") || titleAnchor.text() || "").replace(/\s+/g, " ").trim();
    var magnet = item.find("a[href^=\"magnet:\"]").first().attr("href") || "";
    var name = title || decodeMagnetName(magnet);
    var link = linkOf(magnet, null);
    var href = String(titleAnchor.attr("href") || "");
    var idMatch = href.match(/\/view\/(\d+)/);
    var datetime = dateOf(item.find("td").eq(4).attr("data-timestamp") || item.find("td").eq(4).text());
    if (!magnet || !name || !matches(name)) return null;
    return {
      id: context.source + "-" + (idMatch ? idMatch[1] : index),
      name: name,
      description: null,
      datetime: datetime,
      cloud_types: [link.type],
      links: [link]
    };
  }).filter(function (item) { return item !== null; });
};
