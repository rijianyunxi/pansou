# PanHub · 全网网盘搜索

> 基于 Nuxt 4、Node.js 和 SQLite 的资源源聚合搜索。所有搜索来源都使用同一套 HTTP 请求参数和 `transform(payload, $, context)` 解析函数，不再区分 HTTP、Telegram 或插件搜索架构。

## 核心行为

- **统一资源源**：系统来源保存在 SQLite 的 `resource_sources`，每个来源包含 URL、请求方式、响应格式、请求配置、优先级和 transform；搜索会按优先级从低到高进入执行队列（0 最先起跑），同优先级保持来源目录顺序。
- **单次执行**：每个资源源每次搜索只发起一次请求、执行一次 transform；不自动分页、不使用 cursor、不做关键词变体、深度搜索、fallback 或来源级重试。
- **聚合最新结果**：所有来源并发执行，结果统一去重、按时间倒序排列，并只保留当前请求返回的首屏/最新部分。
- **流式搜索入口**：`/api/search` 仅支持 POST，返回 SSE。旧的 `/api/searchHttp*`、`/api/search/channels*` 入口已删除。
- **用户频道模板**：用户添加公开 Telegram 频道时，首次通过 `/api/account/channels/validate` 校验公开性和可访问性；搜索时使用后台配置的 `source_template_settings` 动态生成资源源，并走同一执行器。
- **统一响应元数据**：响应的 `meta.sources` 列出本次实际参与的全部资源源，`meta.warnings` 汇总超时、网络、业务和解析告警。不再返回 `pluginVersions`、`registryVersion`、`http` 或 `tg` 分组。
- **安全执行**：请求经过 URL/DNS/重定向/请求体/响应体校验；transform 在受限 VM 中同步执行，不能访问网络、文件系统或进程环境。

## 快速开始

```bash
pnpm install
pnpm dev
```

生产环境：

```bash
pnpm build
node .output/server/index.mjs
```

默认 SQLite 文件为 `data/panhub.sqlite`，可通过 `PANHUB_SQLITE_DB` 覆盖。运行数据不应提交到 Git。

### 生产环境变量与部署

`.env.production` 不是必需文件，也不会因为这个文件名自动加载。可以通过进程管理器或服务器环境变量配置生产环境；需要文件管理时，可复制 `.env.example` 为服务器上的 `.env.production`，再修改数据库路径和站点地址。

使用支持 `--env-file` 的 Node.js（例如 Node 22），在项目根目录启动：

```bash
node --env-file=.env.production .output/server/index.mjs
```

Nuxt 生产服务器不会自动读取 `.env`。构建使用默认的 production mode，会自动读取 `.env.production`；这不能代替启动时注入数据库路径等运行参数。代理功能目前只是 [proxy.md](./proxy.md) 中的方案，无需添加尚未实现的代理环境变量。

项目的 `ecosystem.config.cjs` 已提供 PM2 配置，并统一通过 `node_args: "--env-file=.env.production"` 读取生产配置，可用 `pm2 start ecosystem.config.cjs` 启动。修改 `.env.production` 后执行 `pm2 restart panhub --update-env` 重启即可。

建议生产环境设置：

- `PANHUB_SQLITE_DB` 指向持久化数据库的绝对路径，发布时保留已有数据库。
- `NITRO_HOST=127.0.0.1`、`NITRO_PORT` 适用于同机反向代理；需要外部直接访问时按部署网络调整监听地址。
- `NUXT_TRUST_PROXY=true` 从转发头解析真实客户端 IP（`server/utils/clientIp.ts`）。**本仓库的
  `.env.production` 已开启**，前提是应用只监听 `127.0.0.1`（见上一行）且反向代理会写入转发头。

  开启后 `getClientIp()` 依次读 `X-Forwarded-For` / `CF-Connecting-IP`，按 IP 的限流（后台接口、
  账号密码登录、小程序登录、搜索）和审计日志里的 IP 才是真实客户端。若改回 `false`，在反向代理后面
  所有请求都会被算作 `127.0.0.1`，上述限流退化成**全站共用一个配额**，日志 IP 也不可溯源
  ——这是刻意的 fail-safe 默认值，不是 bug。

`NODE_ENV` 与 `NUXT_PUBLIC_*`（站点名、标题、描述、关键词、`SITE_URL`、`API_BASE`）**不必写进
`.env.production`**：`nuxt.config.ts` 的 `runtimeConfig.public` 已给出取值一致的默认值，本仓库的
`.env.production` 因此只保留了真正需要按环境覆盖的几项。`NODE_ENV` 连产物都不读
（构建产物里 `process.env.NODE_ENV` 出现 0 次，Nitro 的 dev/prod 是构建期替换）。要改站点文案或
对外地址，改 `nuxt.config.ts`，或在 `.env.production` 里显式写 `NUXT_PUBLIC_*` 覆盖。

  开启前必须确认反向代理的行为：它要写入 `X-Forwarded-For`，并**剥掉客户端自带的
  `CF-Connecting-IP`**（该头在 `clientIp.ts` 中优先于 `X-Forwarded-For` 被读取，前面不是 Cloudflare
  时不剥离就等于留了一个可被客户端伪造的入口）。如果代理只是把客户端自带的头原样追加透传，
  攻击者每次换一个伪造 IP 就能绕开按 IP 的限流——那比全局限流更差，此时应改回 `false`。
  验证：连发 10 次错误口令触发 429 后，再带 `X-Forwarded-For: 1.2.3.4` 发一次；若返回 401 而不是
  429，说明伪造头被信任，需要回去改代理配置。

首次启动时如果数据库里还没有任何管理员，会创建一个 `admin` 账号：口令取
`PANHUB_ADMIN_INITIAL_PASSWORD`，**未设置则随机生成并在启动日志里打印一次**
（形如 `[PanHub][bootstrap] 已创建初始管理员账号 admin，口令：…`）。仓库不提供任何默认口令，
而管理员没有口令找回通道（只有后台的「修改管理员账号」），所以请立即用该口令登录并改掉。
已有管理员的数据库不会走这段逻辑，也不会被改写口令。

当前 `better-sqlite3 13.0.3` 要求 Node.js 22 或更高版本，并自带多平台预编译模块。本次 `.output/server/node_modules/better-sqlite3/prebuilds` 包含 Linux、Linux musl、Windows 和 macOS 的 x64/arm64 文件，上传时应保留完整 `.output`（包括内部的 `node_modules`）。构建及运行冒烟测试在 Windows / Node 22.22.2 完成，尚未验证目标 Linux 系统的原生模块兼容性；部署后先检查 `/api/health`。若目标系统不兼容，应在匹配的服务器或 CI/容器中执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。不要把根目录开发用 `node_modules` 或本地开发数据库覆盖到线上。

参考：[Nuxt 环境变量说明](https://nuxt.com/docs/4.x/directory-structure/env)、[Node 环境变量文件](https://nodejs.org/api/cli.html#--env-fileconfig)。

## 搜索示例

POST `/api/search`：

```json
{
  "kw": "三体"
}
```

只指定用户添加的频道：

```json
{
  "kw": "三体",
  "channels": ["example_channel"]
}
```

每个 SSE `result` 事件包含一个已完成资源源的增量；`complete` 事件包含最终 `total` 和 `meta`：

```json
{
  "sources": [
    {
      "id": "hunhepan",
      "name": "混合盘",
      "priority": 0,
      "version": "cfg-...",
      "status": "success",
      "resultCount": 3,
      "elapsedMs": 420
    }
  ],
  "warnings": []
}
```

## 后台配置

- `/admin/sources`：资源源配置、启停、导入导出、用户频道模板和来源诊断。
- `/admin/monitor`：资源源和频道健康状态。

资源源的 transform 形式：

```js
function transform(payload, $, context) {
  return [{
    id: "stable-resource-id",
    name: "资源标题",
    description: null,
    datetime: null,
    cloud_types: ["baidu"],
    links: [{ type: "baidu", url: "https://pan.baidu.com/s/xxx", password: null }]
  }];
}
```

`payload` 是本次唯一请求的原始响应，`$` 是 HTML 查询工具，`context` 至少包含 `keyword`、`source`、`format` 和 `rawBody`。解析函数只负责转换结果，不负责发起网络请求。

## 目录结构

```text
pages/                 页面
components/            Vue 组件
server/api/            H3/Nitro API
server/core/services/  搜索、资源源目录、模板、健康和系统设置
server/core/source-runtime/
                       资源源校验、请求执行和 transform 运行时
server/core/storage/   SQLite 结构
utils/                 前端/通用工具
```

## 验证

```bash
pnpm build
git diff --check
```

当前重构不提供旧 API 或旧 Plugin 兼容机制；数据库启动时会自动补齐资源源优先级字段。需要重置本地开发数据时，请停止服务后删除 `data/panhub.sqlite` 再启动。

## 搜索压力测试

脚本会为每次搜索先调用 `/api/account/session` 获取新的匿名 `panhub_session` Cookie，再调用搜索接口，避免复用同一会话触发会话级限流。默认使用 `/api/search/json`，因为该接口会返回每个资源源的 `elapsedMs`、`transformMs` 和 warnings；每次测试会把明细追加到 JSONL，并生成汇总 JSON。

```bash
# 默认：300 次搜索，20 个客户端并发，180 秒内完成
pnpm test:stress-search

# 指定部署地址、并发度和报告目录
pnpm test:stress-search -- \
  --base-url http://111.119.233.153:3000 \
  --requests 300 \
  --concurrency 20 \
  --duration-seconds 180 \
  --output .tmp/my-search-stress
```

报告包含每轮的接口状态、失败资源源、源接口失败、transform 失败、transform 总耗时、上游耗时和 warnings。若部署版本没有返回 `meta.sources[].transformMs`，transform 总耗时会显示为 0，表示服务端未上报该字段，不代表 transform 实际耗时为 0。需要模拟浏览器 SSE 时可追加 `--mode sse`，但 SSE 接口不会暴露源级 transform 诊断。

## 微信小程序登录

已接入微信 code2Session 身份校验与现有用户会话。普通用户不注册，首次微信登录即自动建号，之后仅使用微信登录；后台的“创建管理员”只用于新增管理员。管理员继续从 `/admin` 使用账号密码登录。

网站首页顶栏的登录按钮走**小程序码扫码登录**：点击后展示小程序码，微信扫码进入小程序确认，网页轮询到确认后兑换 cookie 会话（首次扫码同样自动建号）。该入口由后台「系统设置 → 是否展示登录按钮」控制，关闭后首页不再显示按钮，扫码接口同时返回 403。

AppID / AppSecret / 扫码页面 / 打开版本都保存在数据库（`wechat_mini_settings`），在后台「系统设置 → 微信小程序」卡片里维护，保存后立即生效，**不需要环境变量、也不需要重启**。AppSecret 只写不读：接口只回报"是否已配置"和长度，永不回传值或其片段；提交时留空表示不修改。配置、准入开关及小程序示例见 [接入方案](docs/wechat-mini-login.md)。
