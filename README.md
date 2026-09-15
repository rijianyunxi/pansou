# PanHub · 全网网盘搜索

> 一个搜索框，聚合 Telegram 公开频道和可配置上游，提供去重、健康监控与安全的动态来源管理。


**在线体验**：<https://panhub.shenzjd.com>

> 当前运行目标是 **Node.js + SQLite**。SQLite、Telegram Session 和管理配置需要可写的本地文件系统。

## ✨ 核心特性

### 🔍 搜索

- **多源聚合**：默认搜索系统 Telegram 公开频道和 SQLite 中配置的 HTTP 上游（混合盘、PanSearch、Nyaa）；管理员还可以继续添加或调整来源。
- **服务端统一调度与流式返回**：Telegram 与插件来源共享每次搜索的来源任务并发槽，插件按 `priority` 分批调度；`/api/search` 只返回 SSE，每次成功的后端调用各生成一次增量，连续成功不足 300ms 时进入 FIFO 队列并逐个推送。
- **搜索范围选择**：本站搜索使用服务端默认来源；“已选频道”只搜索浏览器当前保存的自定义 Telegram 频道。
- **暂停/继续与重置**：暂停或重新搜索会取消旧请求；继续搜索使用暂停时保存的关键词和范围快照。
- **结果处理**：服务端按时间降序合并结果并去重，客户端支持按日期、名称等方式再次排序和按平台筛选展示。
- **自动重试与取消**：网络重试使用可取消的退避；请求断开或超时后停止后续请求、关键词变体和故障转移。
- **缓存**：按统一默认搜索的规范化关键词复用已完成结果的进程内内存 LRU 缓存，TTL 默认 10 分钟并从 SQLite 配置读取；自定义频道/来源/接口过滤请求不复用关键词缓存；同一关键词并发请求会合并为一次上游请求，部分失败或空结果不会写入缓存。

### 🔥 热搜与持久化

- 热搜词展示与使用次数统计。
- Node.js 默认使用 SQLite `data/panhub.sqlite`（WAL）持久化搜索设置、上游目录、来源执行配置、解析函数、密钥、Telegram 账户/频道配置、健康快照和热搜。

### 🎨 用户体验

- Vue 3 + Nuxt 4，支持深色模式和桌面/移动端响应式布局。
- 可选 `SEARCH_PASSWORD` 搜索密码门，解锁 Cookie 有效期 30 天。
- 单个频道或上游失败时返回 warning，不会把失败误报为空结果；已完成来源的结果仍会展示。

### 🛡️ 稳定性与安全

- 所有上游请求与 transform 共用 `system_settings.request_timeout_ms`（SQLite，默认 5 秒，范围 1–60 秒）；整次搜索另有 30 秒总预算。
- 搜索接口有实例级治理：客户端在途并发默认 3、实例全局在途默认 16，并限制 30 秒窗口内已接纳请求数。
- 来源执行请求统一通过 `SafeHttpExecutor`：默认仅 HTTPS（schema 支持显式 `allowInsecureHttp`，但上游目录转换会强制关闭），校验 DNS 解析后的地址，逐跳校验重定向，并限制请求/响应体、端口、请求头和总预算。
- 健康监控区分网络、HTTP、业务、解析和结果五个维度，并保留有限的历史趋势和熔断状态。

## 🚀 快速开始

### 本地运行

Telegram MTProto 在 PanHub 服务端进程内运行。API ID、API Hash 只配置在服务端 `.env`，登录会话默认保存到 `data/telegram-session.txt`。

```bash
# 在项目根目录执行
pnpm install
pnpm dev
```

随后访问 <http://localhost:3000>。需要 Telegram 账户功能时，先配置 `TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH`，再打开管理台的「TG 账户管理」完成登录。

生产环境请使用 Node.js 进程管理器或操作系统服务运行 `pnpm build` 生成的 Nitro Node server，并确保 `data/` 可写。

## 📖 使用指南

### 搜索范围

- **本站**：只提交关键词，例如 `{"kw":"三体"}`；服务端合并系统频道和已启用插件。
- **已选频道**：调用独立接口 `/api/search/channels`（或 `/api/searchHttp/channels`），提交本次要搜索的公开 Telegram 用户名，例如 `{"kw":"三体","channels":["my_channel"]}`；只搜索请求中传入的频道，与系统配置完全无关。
- 频道设置只保存在当前浏览器。支持 `@name`、`t.me/name` 和公开消息链接，保存前会进行格式校验。
- “已选频道”没有频道时前端禁用搜索，后端也会返回 400，不会回退到本站搜索。

### 搜索 SSE 协议

`GET /api/search` 和 `POST /api/search` 均只返回 `text/event-stream`，不再提供一次性 JSON 响应。POST 客户端应使用 `fetch` 读取响应流。事件顺序如下：

- `start`：搜索已接纳，包含服务端推送间隔 `intervalMs: 300`。
- `result`：一次成功后端调用的增量；`data.update.results` 为资源级归一化结果，每条资源包含 `cloud_types[]` 和带 `type`、`url`、`password` 的 `links[]`。来源和插件诊断字段仅在 `debug=1` 时出现在 `data.update.source` 与结果记录中。流内已发送结果会被剔除；即使本次没有新增结果，也仍会为该次成功调用发送一个空增量事件。第一次成功立即推送，后续成功调用进入 FIFO 队列，相邻 `result` 事件间隔不小于 300ms。
- `complete`：只包含最终 `total`、可选 `meta` 和 warnings，不重复发送完整结果；客户端应保留并展示此前收到的增量。`datetime` 统一为 `YYYY/MM/DD HH:mm:ss`（Asia/Shanghai），插件来源字段仅在 `debug=1` 时返回。
- `error`：流建立后的搜索错误。认证、参数校验和并发治理在建流前仍使用对应 HTTP 状态码。

`/api/searchHttp` 返回同样的资源级归一化 `results[]`；需要只搜索本次传入的 Telegram 频道时使用 `/api/searchHttp/channels`。SSE 接口对应为 `/api/search/channels`。搜索接口不再提供 `res` 参数，也不返回扁平链接或 `items[]`。

每条 `results[]` 资源固定使用以下结构：

```json
{
  "id": "稳定资源标识",
  "name": "资源名称",
  "description": "资源描述或 null",
  "datetime": "2026/09/14 23:10:05",
  "cloud_types": ["baidu", "quark"],
  "links": [
    { "type": "baidu", "url": "https://pan.baidu.com/s/...", "password": "abcd" },
    { "type": "quark", "url": "https://pan.quark.cn/s/...", "password": null }
  ]
}
```

`links[]` 是资源的多地址集合，密码与地址一一对应；`datetime` 固定为中国时区的 `YYYY/MM/DD HH:mm:ss`。`source`、`channel`、`pluginId`、`pluginVersion`、`registryVersion` 以及响应 `meta` 只在显式传入 `debug=1` 时返回。

### 管理控制台 `/admin`

管理控制台使用独立的 `ADMIN_PASSWORD` 和管理员 Cookie（有效期 8 小时），不复用 `SEARCH_PASSWORD`。未配置 `ADMIN_PASSWORD` 时管理 API 返回 503。

管理后台使用路径路由，不再用 `?view=` 区分页面；回收站作为来源管理页面内的弹窗操作：

- `/admin/sources`：来源管理，编辑请求、响应映射、启停、调试以及版本状态。
- `/admin/monitor`：健康监控，汇总上游和 Telegram 频道的健康状态、五维指标、趋势、熔断和行内操作；来源与性能设置在此页面打开。
- `/admin/accounts`：Telegram 账户管理，支持扫码登录、手机号验证码登录和两步验证；API 凭据与 Session 不在页面填写。
- `/admin/telegram`：Telegram 频道诊断，支持单频道/批量探测和原始报文查看。
- `/admin/sources` 内的“回收站”弹窗：管理已归档的自定义上游，支持恢复或输入 ID 永久删除。
- `/admin`：规范化重定向到 `/admin/sources`。

旧入口仍兼容重定向：`/upstreams`、`/monitor`、`/tg-accounts`、`/telegram`，以及历史 `/admin?view=monitor`、`/admin?view=accounts` 等链接会自动迁移到对应路径。

### Telegram 诊断页 `/admin/telegram`

这是独立于管理控制台壳的频道诊断页，使用同一套管理员认证：

- 展示有效的公开频道清单和健康状态。
- 支持单频道/全部频道检测、原始请求与响应、直连和 Jina fallback 阶段、耗时、结构变化和失败分类。
- 支持文本/HTML/源码查看、复制报文以及受限沙箱预览。
- 调试记录保存在当前浏览器内存，不会直接修改正式搜索配置；频道启停、删除和策略配置由管理 API 持久化。

### 配置解析函数

- HTTP 上游通过 `/api/settings/upstreams` 配置请求、响应格式和 `transform(payload, $, context)` 解析函数，保存后生效。
- Telegram 每个频道通过 `/api/settings/upstreams` 配置独立的请求与解析函数；`/api/settings/tg-source` 只保存共享抓取模板、Headers 和重试参数。解析函数运行在受限 `node:vm` 环境中，只负责把已取得的 HTML/文本转换为统一结果，不负责发起网络请求。
- 解析函数统一由来源配置管理，不提供独立解析器管理台。

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 |
|---|---:|---|
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `PORT` | `3000` | 服务端口 |
| `SEARCH_PASSWORD` | 空 | 非空时启用搜索密码门，Cookie 有效期 30 天 |
| `ADMIN_PASSWORD` | 空 | 管理控制台专用密码，不回退到搜索密码 |
| `PANHUB_SQLITE_DB` | `data/panhub.sqlite` | SQLite 数据库位置 |
| `NUXT_SEARCH_TIMEOUT_MS` | `30000` | 单次搜索总预算，范围 1000–120000 ms |
| `TELEGRAM_API_ID` | 空 | Telegram MTProto 应用 ID，仅服务端使用 |
| `TELEGRAM_API_HASH` | 空 | Telegram MTProto 应用 Hash，仅服务端使用 |
| `TELEGRAM_SESSION_FILE` | `./data/telegram-session.txt` | Telegram 登录 Session 文件 |

SQLite 结构化表是唯一持久化源；项目不读取旧 JSON 或通用 KV 配置。

## 🏗️ 技术架构

- **前端**：Nuxt 4、Vue 3、TypeScript、原生 CSS。
- **服务端**：Nitro Node server、H3 API、`better-sqlite3`、Cheerio、`ofetch`。
- **Telegram**：`telegram` MTProto 客户端，服务端进程内嵌。
- **测试**：Vitest（隔离单测）+ Playwright（交互/E2E）。

核心目录：

```text
server/core/
├── services/       # 搜索编排、Telegram、上游目录、热搜和系统设置
├── plugins/        # 来源 Registry、仓库和健康状态
├── source-runtime/  # 来源请求、校验、重试、transform 和执行器
├── http/           # SafeHttpExecutor
├── security/       # URL/DNS、限流和搜索并发治理
├── telegram/       # MTProto 账户与会话
├── cache/           # 统一内存缓存
└── storage/         # SQLite 结构化存储
```

## 🛠️ 开发与构建

```bash
pnpm dev
pnpm typecheck
pnpm build                # Node server 生产构建
pnpm preview
```

提交前至少运行：

```bash
pnpm typecheck
pnpm build
git diff --check
```

## 📦 支持的网盘类型

搜索结果中的 `cloud_types` 只使用统一标识：`baidu`、`quark`、`aliyun`、`mobile`、`tianyi`、`115`、`123`、`jianguoyun`、`lanzou`、`xunlei`、`magnet`、`others`。类型由链接域名判断，`pan.xunlei.com` 归为 `xunlei`，`magnet:` 归为 `magnet`，未知地址和 ED2K 归为 `others`。

## ⚠️ 免责声明

本项目仅用于技术学习与搜索聚合演示，不存储或传播资源内容。资源链接来自公开 Telegram 频道和第三方网站，请遵守适用法律法规及各平台服务条款。

## 📄 许可证

`package.json` 声明项目采用 MIT License。

---

开发边界、接口协议、Manifest/来源执行 schema、备份恢复和当前剩余待办统一见 [`TODO.md`](TODO.md)。
