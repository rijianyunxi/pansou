export interface AdapterMapping {
  items: string;
  title: string;
  url: string;
  type: string;
  password: string;
  linkArray?: string;
}

export interface UpstreamDefinition {
  id: string;
  name: string;
  description: string;
  url: string;
  method: "GET" | "POST";
  format: "json" | "html";
  plugin: string;
  adapter: string;
  color: string;
  initials: string;
  mapping: AdapterMapping;
  builtin: boolean;
}

const diskMapping: AdapterMapping = {
  items: "data.list",
  title: "disk_name",
  url: "link",
  type: "disk_type",
  password: "disk_pass",
};
const htmlMapping: AdapterMapping = {
  items: "",
  title: "",
  url: "",
  type: "",
  password: "",
};
export const BUILTIN_UPSTREAMS: UpstreamDefinition[] = [
  {
    id: "hunhepan",
    name: "混合盘",
    description: "混合盘主搜索接口",
    url: "https://hunhepan.com/open/search/disk",
    method: "POST",
    format: "json",
    plugin: "hunhepan",
    adapter: "disk-json",
    color: "#5964d9",
    initials: "H",
    mapping: { ...diskMapping },
    builtin: true,
  },
  {
    id: "nyaa",
    name: "Nyaa",
    description: "动漫与磁力资源",
    url: "https://nyaa.si/",
    method: "GET",
    format: "html",
    plugin: "nyaa",
    adapter: "nyaa-html",
    color: "#398b70",
    initials: "N",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "pansearch",
    name: "PanSearch",
    description: "Next.js 数据接口",
    url: "https://www.pansearch.me/search",
    method: "GET",
    format: "html",
    plugin: "pansearch",
    adapter: "next-data",
    color: "#4085b8",
    initials: "P",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "duoduo",
    name: "多多",
    description: "影视资源 · 搜索页探测",
    url: "https://tv.yydsys.top",
    method: "GET",
    format: "html",
    plugin: "duoduo",
    adapter: "html-probe",
    color: "#c18b40",
    initials: "D",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "qkpanso",
    name: "QKPanso",
    description: "混合盘插件的独立上游",
    url: "https://qkpanso.com/v1/search/disk",
    method: "POST",
    format: "json",
    plugin: "hunhepan",
    adapter: "disk-json",
    color: "#9971bb",
    initials: "Q",
    mapping: { ...diskMapping },
    builtin: true,
  },
  {
    id: "kuake8",
    name: "Kuake8",
    description: "混合盘插件的独立上游",
    url: "https://kuake8.com/v1/search/disk",
    method: "POST",
    format: "json",
    plugin: "hunhepan",
    adapter: "disk-json",
    color: "#5c999f",
    initials: "K",
    mapping: { ...diskMapping },
    builtin: true,
  },
  {
    id: "jikepan",
    name: "极客盘",
    description: "多网盘聚合搜索",
    url: "https://api.jikepan.xyz/search",
    method: "POST",
    format: "json",
    plugin: "jikepan",
    adapter: "nested-links",
    color: "#64838d",
    initials: "J",
    mapping: {
      items: "list",
      title: "name",
      linkArray: "links",
      url: "link",
      type: "service",
      password: "pwd",
    },
    builtin: true,
  },
  {
    id: "qupansou",
    name: "趣盘搜",
    description: "Funletu 资源接口",
    url: "https://v.funletu.com/search",
    method: "POST",
    format: "json",
    plugin: "qupansou",
    adapter: "resource-json",
    color: "#b97967",
    initials: "Q",
    mapping: {
      items: "data",
      title: "title",
      url: "url",
      type: "",
      password: "",
    },
    builtin: true,
  },
  {
    id: "panta",
    name: "盘他",
    description: "社区搜索 · 搜索页探测",
    url: "https://www.91panta.cn/search",
    method: "GET",
    format: "html",
    plugin: "panta",
    adapter: "html-probe",
    color: "#83945a",
    initials: "P",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "labi",
    name: "蜡笔",
    description: "影视资源 · 搜索页探测",
    url: "http://xiaocge.fun",
    method: "GET",
    format: "html",
    plugin: "labi",
    adapter: "html-probe",
    color: "#a07e5d",
    initials: "L",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "thepiratebay",
    name: "海盗湾",
    description: "磁力资源 · 搜索页探测",
    url: "https://tpirbay.xyz",
    method: "GET",
    format: "html",
    plugin: "thepiratebay",
    adapter: "html-probe",
    color: "#7381a1",
    initials: "T",
    mapping: { ...htmlMapping },
    builtin: true,
  },
  {
    id: "xuexizhinan",
    name: "学习指南",
    description: "图书资源 · 搜索页探测",
    url: "https://xuexizhinan.com/",
    method: "GET",
    format: "html",
    plugin: "xuexizhinan",
    adapter: "html-probe",
    color: "#9c7685",
    initials: "X",
    mapping: { ...htmlMapping },
    builtin: true,
  },
];

export function buildUpstreamRequest(id: string, keyword: string) {
  const source = BUILTIN_UPSTREAMS.find((s) => s.id === id);
  if (!source) throw new Error("Unknown built-in upstream");
  let url = source.url;
  let body: Record<string, unknown> | undefined;
  const kw = encodeURIComponent(keyword);
  if (["hunhepan", "qkpanso", "kuake8"].includes(id))
    body = {
      q: keyword,
      exact: true,
      page: 1,
      size: 30,
      type: "",
      time: "",
      from: "web",
      user_id: 0,
      filter: true,
    };
  else if (id === "jikepan") body = { name: keyword, is_all: false };
  else if (id === "qupansou")
    body = {
      style: "get",
      datasrc: "search",
      query: {
        id: "",
        datetime: "",
        courseid: 1,
        categoryid: "",
        filetypeid: "",
        filetype: "",
        reportid: "",
        validid: "",
        searchtext: keyword,
      },
      page: { pageSize: 1000, pageIndex: 1 },
      order: { prop: "sort", order: "desc" },
      message: "请求资源列表数据",
    };
  else if (id === "nyaa") url += `?f=0&c=0_0&q=${kw}&s=seeders&o=desc`;
  else if (["duoduo", "labi"].includes(id))
    url += `/index.php/vod/search/wd/${kw}.html`;
  else if (id === "thepiratebay") url += `/search/${kw}/1/99/0`;
  else if (id === "xuexizhinan") url += `?post_type=book&s=${kw}`;
  else if (id === "panta") url += `?keyword=${kw}`;
  return { url, method: source.method, body };
}

export type ProbeState = "available" | "warning" | "error";
export interface ProbeTrace {
  url: string;
  method: string;
  status: number | null;
  elapsedMs: number;
  bytes: number;
  contentType: string;
  error?: string;
}
export interface UpstreamProbe {
  sourceId: string;
  checkedAt: string;
  state: ProbeState;
  message: string;
  elapsedMs: number;
  httpStatus: number | null;
  businessCode?: string;
  traces: ProbeTrace[];
  raw: string;
  rawTruncated: boolean;
  results: import("../server/core/types/models").SearchResult[];
}
