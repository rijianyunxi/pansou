// https://nuxt.com/docs/api/configuration/nuxt-config
const requestedSearchTimeout = Number(process.env.NUXT_SEARCH_TIMEOUT_MS);
const searchTimeoutMs = Number.isFinite(requestedSearchTimeout) && requestedSearchTimeout >= 1_000
  ? Math.min(120_000, Math.round(requestedSearchTimeout))
  : 30_000;

export default defineNuxtConfig({
  // Allow dev, typecheck, and build commands to run without replacing each other's
  // generated Nuxt runtime in the same checkout.
  buildDir: process.env.PANHUB_BUILD_DIR || ".nuxt",
  // 工作区中的临时截图/替换文件不是应用页面，避免被 Nuxt typecheck 扫描。
  ignore: ["**/admin-index.vue替换_*.vue"],
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "PanHub · 全网最全的网盘搜索",
      titleTemplate: "%s · PanHub",
      meta: [
        {
          name: "viewport",
          content:
            "width=device-width, initial-scale=1, viewport-fit=cover",
        },
        {
          name: "description",
          content:
            "PanHub：聚合阿里云盘、夸克、百度网盘、115、迅雷等平台的全网最全网盘搜索工具，实时检索分享资源，免费、快速、无广告。",
        },
        {
          name: "keywords",
          content:
            "网盘搜索, 阿里云盘, 夸克, 百度网盘, 115, 迅雷, 资源搜索, 盘搜, panhub, 网盘聚合搜索",
        },
        { name: "theme-color", content: "#111111" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "PanHub" },
      ],
      link: [{ rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    },
  },
  // 开发期预打包动态引入的依赖，避免首次使用时才触发
  // "new dependencies optimized" 导致的整页重载与模块加载失败
  vite: {
    ssr: { noExternal: ["telegram", "qrcode"] },
    optimizeDeps: {
      include: ["p-limit", "TagCloud"],
    },
  },
  nitro: {
    // 当前项目只支持 Node server 运行时。
    preset: "node-server",
  },
  routeRules: {
    // 管理控制台（含旧 /upstreams 重定向）依赖管理员 Cookie 鉴权，禁止缓存
    "/admin": { swr: false, cache: false },
    "/upstreams": { swr: false, cache: false },
    // 健康监控重定向页禁止缓存
    "/monitor": { swr: false, cache: false },
    "/api/monitor": { swr: false, cache: false },
    "/api/upstreams/**": { swr: false, cache: false },
    "/api/plugins/**": { swr: false, cache: false },
    "/api/parser-plugins": { swr: false, cache: false },
    "/api/parser-plugins/**": { swr: false, cache: false },
    "/telegram": { swr: false, cache: false },
    "/tg-accounts": { swr: false, cache: false },
    "/api/tg/**": { swr: false, cache: false },
    "/api/tg/accounts/**": { swr: false, cache: false },
    "/api/tg/mtproto/**": { swr: false, cache: false },
    // 健康接口反映实时运行状态，禁止缓存
    "/api/plugin-health": { swr: false, cache: false },
    "/api/health": { swr: false, cache: false },
    // 管理端搜索设置不缓存
    "/api/settings/**": { swr: false, cache: false },
    // 热搜接口不缓存，否则 POST 写入后 GET 仍返回旧数据
    "/api/hot-searches": { swr: false, cache: false },
    // 密码门接口不缓存，确保 POST body 正常处理
    "/api/auth/**": { swr: false, cache: false },
    // 搜索接口依赖 Cookie 鉴权，禁止缓存避免 401 被缓存
    "/api/search": { swr: false, cache: false },
    "/**": { swr: 3600 },
  },
  runtimeConfig: {
    // server-only 配置
    searchPassword: process.env.SEARCH_PASSWORD || "",
    adminPassword: process.env.ADMIN_PASSWORD || "",
    searchTimeoutMs,
    cacheEnabled: true,
    public: {
      apiBase: "/api",
      siteUrl: "https://panhub.shenzjd.com",
    },
  },
});
