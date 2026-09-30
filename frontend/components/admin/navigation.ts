export const adminNavigation = [
  {
    path: "/admin/monitor",
    title: "运行监控",
    icon: "activity",
    group: "概览",
  },
  {
    path: "/admin/sources",
    title: "来源管理",
    icon: "layers",
    group: "资源与采集",
  },
  {
    path: "/admin/crawl",
    title: "TG 采集",
    icon: "database",
    group: "资源与采集",
  },
  {
    path: "/admin/proxies",
    title: "代理节点",
    icon: "network",
    group: "资源与采集",
  },
  {
    path: "/admin/resources",
    title: "网盘资源",
    icon: "folder",
    group: "资源与采集",
  },
  {
    path: "/admin/hot-searches",
    title: "热门搜索",
    icon: "flame",
    group: "运营管理",
  },
  {
    path: "/admin/users",
    title: "用户管理",
    icon: "users",
    group: "运营管理",
  },
  {
    path: "/admin/logs",
    title: "搜索日志",
    icon: "logs",
    group: "运营管理",
  },
  {
    path: "/admin/policies",
    title: "系统设置",
    icon: "settings",
    group: "系统",
  },
] as const;
