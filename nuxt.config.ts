// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  buildDir: process.env.PANHUB_BUILD_DIR || ".nuxt",
  // 工作区中的临时截图/替换文件不是应用页面，避免被 Nuxt typecheck 扫描。
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  // 生产包不发布 source map：减少构建产物体积，也避免暴露源码结构。
  sourcemap: { server: false, client: false },
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      meta: [
        {
          name: "viewport",
          content: "width=device-width, initial-scale=1, viewport-fit=cover",
        },
        { name: "theme-color", content: "#111827" },
      ],
      link: [{ rel: "icon", type: "image/x-icon", href: "/favicon.ico" }],
    },
  },
  // 开发期预打包动态引入的依赖，避免首次使用时才触发
  // "new dependencies optimized" 导致的整页重载与模块加载失败
  vite: {
    optimizeDeps: {
      include: ["p-limit"],
    },
    build: {
      // 首页与后台页面的 CSS 分开输出，避免首页首屏加载后台样式。
      cssCodeSplit: true,
    },
  },
  nitro: {
    // 当前项目只支持 Node server 运行时。
    preset: "node-server",
    // 构建时为 public/_nuxt 下的静态资源生成 .gz/.br；动态 API 和 SSE 不会被
    // 这个选项预压缩，避免影响搜索接口的实时流式响应。
    compressPublicAssets: {
      gzip: true,
      brotli: true,
    },
  },
  routeRules: {
    // 文件名带内容 hash，允许浏览器和 CDN 长期缓存，减少重复传输。
    "/_nuxt/**": {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
      },
    },
    // 管理控制台及其路径页面依赖账号会话和角色鉴权，禁止缓存
    "/admin": { swr: false, cache: false },
    "/admin/**": { swr: false, cache: false },
    "/api/monitor": { swr: false, cache: false },
    "/api/upstreams/**": { swr: false, cache: false },
    "/api/tg/**": { swr: false, cache: false },
    // 健康接口反映实时运行状态，禁止缓存
    "/api/source-health": { swr: false, cache: false },
    "/api/health": { swr: false, cache: false },
    // 管理端搜索设置不缓存
    "/api/settings/**": { swr: false, cache: false },
    // 热搜接口不缓存，否则 POST 写入后 GET 仍返回旧数据
    "/api/hot-searches": { swr: false, cache: false },
    "/api/hot-search-stats": { swr: false, cache: false },
    // 普通用户会话与账号写接口必须保留 Cookie 和请求体，禁止全局 SWR 接管
    "/api/account/**": { swr: false, cache: false },
    "/api/admin/**": { swr: false, cache: false },
    // 搜索接口依赖匿名/登录会话，禁止缓存避免鉴权结果被复用；
    // POST 搜索必须保留请求体，不能被通用 SWR 包装器接管。
    "/api/search": { swr: false, cache: false },
    "/api/search/**": { swr: false, cache: false },
    "/**": { swr: 3600 },
  },
  runtimeConfig: {
    // Private server-only setting. Override at runtime with NUXT_TRUST_PROXY.
    // Only enable when the app is reachable exclusively through a trusted
    // reverse proxy; otherwise forwarded client-IP headers are spoofable.
    trustProxy: false,
    public: {
      // Public site settings are supplied by matching NUXT_PUBLIC_* variables.
      // Keep the keys here so Nuxt exposes them to both SSR and the browser.
      apiBase: "",
      siteUrl: "",
      siteName: "",
      homeTitle: "",
      homeDescription: "",
      siteTitle: "",
      siteDescription: "",
      siteKeywords: "",
      siteImageAlt: "",
    },
  },
});
