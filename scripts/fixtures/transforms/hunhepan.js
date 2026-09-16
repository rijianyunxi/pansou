export default function transform(payload, $, context) {
  if (payload && payload.code === 0 && payload.msg && !Array.isArray(payload.data?.list)) throw new Error("混合盘: " + payload.msg);
  var keyword = String(context.keyword || "").trim().toLowerCase();
  var compact = function (value) { return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); };
  var needle = compact(keyword);
  var matches = function (value) { return !needle || compact(value).indexOf(needle) >= 0; };
  var clean = function (value) { return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); };
  var descriptionOf = function (value, title) {
    var source = String(value || "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, " ")
      .replace(/\*\*|__|\x60/g, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/(?:https?:\/\/|magnet:\?)[^\s<>"')\]]+/gi, " ");
    var label = /(?:^|[\s\p{Extended_Pictographic}\uFE0F\u200D])(?:【|\[)?(?:资源描述|资源简介|剧情简介|内容简介|描述|简介|剧情介绍|摘要|介绍)(?:】|\])?\s*[:：]\s*/iu;
    var found = source.match(label);
    if (found) source = source.slice((found.index || 0) + found[0].length);
    else if (title) {
      var titleText = String(title || "").trim();
      var titleIndex = titleText ? source.indexOf(titleText) : -1;
      if (titleIndex >= 0) source = source.slice(titleIndex + titleText.length);
    }
    var stop = /(?:阿里(?:云盘)?|阿里|夸克(?:网盘)?|百度(?:网盘)?|迅雷(?:云盘)?|115(?:网盘)?|UC(?:网盘)?|天翼云盘|移动云盘|坚果云|蓝奏云|123网盘|网盘|下载地址|下载链接|资源链接|链接|提取码|密码|文件大小|大小|资源类型|类型|资源标签|标签|来源|来自|频道|群组|机器人|订阅|更新时间|上映|导演|主演|制片|评分|豆瓣|TMDB|画质|视频|字幕|分享)\s*[:：]|(?:👇|🔗|📁|📂|🏷|📢|🤖|🙍|👥)/i;
    var boundary = source.search(stop);
    if (boundary >= 0) source = source.slice(0, boundary);
    return clean(source).replace(/^[：:;；|｜,，]+/, "").replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").trim() || null;
  };
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
    return pair ? pair[1] : /(^|\\.)lanzou[a-z0-9-]*\\.com$/.test(host) ? "lanzou" : "others";
  };
  var linkOf = function (url, password) { return { type: cloudTypeOf(url), url: url, password: password || null }; };
  var list = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : [];
  return list.map(function (item, index) {
    var name = clean(item && item.disk_name);
    var description = descriptionOf(item && (item.files || item.description || ""), name);
    var url = String((item && item.link) || "").trim();
    var link = linkOf(url, item && (item.disk_pass || item.password));
    if (!url || !matches(name + " " + description)) return null;
    return { id: String((item && (item.disk_id || item.doc_id)) || context.source + "-" + index), name: name, description: description || null, datetime: dateOf(item && (item.update_time || item.updated_at || item.create_time || item.created_at || item.shared_time || item.time)), cloud_types: [link.type], links: [link] };
  }).filter(function (item) { return item !== null; });
};
