# PanHub 开发路线图与项目开发文档

> **版本**：v4.0  
> **更新日期**：2026-09-13  
> **目标仓库**：`rijianyunxi/pansou`（当前工作树远端配置为 `joyce677/panhub`）  
> **当前状态**：搜索、动态 Instructions、SQLite 配置仓库、Telegram 管理/诊断和本地健康监控已形成可用闭环；当前重点是补齐等价上游池、来源质量、解析插件管理台和可观测性。

本文同时承担路线图、实现边界和开发说明。`docs/` 下的旧上游工作台文档已删除，不再维护重复入口；README 只描述安装、使用和面向使用者的功能。

## 状态与优先级

- `[x]` 已在当前工作树源码中实现，并有明确运行时入口。
- `[ ]` 尚未完成，不能因为有类型定义、配置字段或孤立组件就标记完成。
- `P0` 阻塞核心安全或正式搜索闭环；`P1` 核心能力增强；`P2` 质量、性能和运维增强。
- 历史记录只用于说明变更背景；当前未完成项以第 2 节为准。

---

## 1. 当前能力快照

### 1.1 已完成

- [x] Nuxt 4 + Vue 3 + TypeScript 应用，默认 Node server 构建。
- [x] 搜索服务统一编排 Telegram 和插件来源：优先级分批、来源并发、超时、取消、重试、去重、时间排序和 warning 聚合。
- [x] 默认系统 Telegram 清单为 48 个去重后的公开频道；支持浏览器自定义频道、`only` 搜索范围和服务端频道策略。
- [x] 4 个内置 Code Plugin：`hunhepan`、`pansearch`、`duoduo`、`nyaa`。
- [x] 动态 Instructions 插件：JSON/HTML 请求、字段映射、分页、多阶段、受限变量、样本验证、版本发布、停用、回滚、导入导出和热更新。
- [x] Parser Plugin：同步 JavaScript 转换器运行时、版本仓库、测试、发布、停用、归档、回滚、导入导出，以及按上游/TG 频道绑定。
- [x] 上游目录和搜索设置服务端持久化；浏览器只保留 UI 偏好和临时诊断状态。
- [x] SQLite `data/panhub.sqlite` 通过结构化表统一存储配置、插件、密钥、TG 账户/频道设置、健康快照和热搜。
- [x] 管理控制台 `/admin`：健康监控、上游接口、TG 账户管理、搜索设置和垃圾箱；`/upstreams`、`/monitor`、`/tg-accounts` 提供兼容重定向。
- [x] `/telegram` 诊断页：单频道/批量探测、原始报文、直连/Jina 阶段、耗时、结构变化告警和受限预览。
- [x] 五维健康状态（network/http/business/parsing/results）、失败分类、熔断、加权轮询、失败切换、有限历史趋势和本地持久化。
- [x] `SafeHttpExecutor`、DNS 校验与 Node 出站 IP 钉住、重定向逐跳检查、请求/响应预算、管理鉴权、同源校验和限流。
- [x] 已清理豆瓣热榜、图片代理、Cloudflare 发布配置、旧 CI 工作流、孤立 iOS 页面和未接入 Registry 的失效插件来源。

### 1.2 明确边界

- 当前运行目标是 **Node.js + SQLite**；部署说明只维护 Node.js 进程运行方式，不再维护 Docker、Oracle Cloud、Vercel 或 Cloudflare 平台配置。
- `/api/search` 只使用 SSE：成功后端调用逐个增量推送，最小推送间隔 300ms；客户端暂停会取消当前流，继续时重新发起原始参数快照。
- Telegram、Code Plugin 和 Instructions Plugin 共享每次搜索的来源任务并发槽；插件内部的多个 HTTP 请求可能继续受插件自身预算约束。
- 运行时 Parser Plugin 只允许同步转换，代码在 `node:vm` 中执行，不提供 `require`、`process`、文件系统或网络能力。
- `components/admin/ParserPluginMarket.vue` 和 Parser Plugin API 已存在，但当前 `pages/admin/index.vue` 没有挂载独立的 `parsers` 视图；不能把 `?view=parsers` 当作现成的管理台入口。
- 健康快照目前是本地实例级持久化；多副本之间没有共享健康状态或主动变更通知。

---

## 2. 当前未完成项（按优先级）

### P0：无

当前没有已知的 P0 阻塞项。任何涉及动态 URL、密钥、管理员接口的改动仍必须先补安全测试，再进入正式搜索。

### P1：核心来源和管理能力

- [ ] **等价上游最低延时策略**：在现有加权轮询和失败切换上增加可选的最低延时优先，并以健康窗口数据为依据，避免单次偶然慢请求造成抖动。
- [ ] **PanSearch 失效恢复**：完善 buildId 缓存/刷新、阶段请求失败恢复和结构变更诊断；现有代码已能执行阶段请求，但还没有稳定的 buildId 生命周期策略。
- [ ] **多多完整搜索**：从当前搜索页/入口级能力补齐结果列表、详情或链接提取，并增加脱敏 fixture 和失败分类测试。
- [ ] **正式来源测试覆盖**：为混合盘、PanSearch、多多补齐脱敏 fixture、解析测试、业务错误和结构变化测试；TG 与 Nyaa 已有主要离线覆盖。
- [ ] **Parser Plugin 管理台接入**：将 `ParserPluginMarket.vue` 接入 `/admin` 导航和路由，明确其与 Instructions 上游的区别，并覆盖未认证、编辑、测试、发布、回滚、归档和移动端流程。
- [ ] **TG 频道管理入口收敛**：修正仍指向 `/admin?view=telegram` 的兼容链接；当前 admin 的 `ConsoleView` 没有 `telegram` 分支，TG 频道目录实际位于 `/telegram`。
- [ ] **TG 频道标签与备注**：在服务端频道配置、导入导出、列表、筛选和诊断上下文中增加可持久化的标签/备注字段。

### P2：质量、性能和运维

- [ ] 规范化分享链接并移除无关追踪参数后再去重。
- [ ] 将同一资源的多个来源聚合展示，而不是只保留一条。
- [ ] 增加相关性评分（标题命中、关键词覆盖、时间和来源质量）。
- [ ] 将失效链接检测做成异步任务，不阻塞首屏结果。
- [x] `/api/search` 改为纯 SSE；定义 `start/result/complete/error` 事件、300ms FIFO 队列节流、缓存来源标记和部分结果协议。
- [ ] 评估 Telegram、Code Plugin、Instructions Plugin 独立并发池的收益与复杂度。
- [ ] 暴露缓存命中率、来源耗时、结果数、解析失败率和取消率等指标；现有健康数据不等同于完整指标系统。
- [ ] 增加 10/50/100 并发压测，记录 CPU、内存、P95/P99 和实例级限流行为。
- [ ] 统一结构化日志字段：`requestId`、`searchId`、`pluginId`、`pluginVersion`、`registryVersion`。
- [ ] 评估 Prometheus/OpenTelemetry；在此之前不承诺已有监控端点兼容这些协议。
- [ ] 明确原始报文、调试日志和 SQLite 备份的保留期限及自动清理策略。
- [ ] 若未来恢复 CI/CD，再增加依赖漏洞扫描、密钥扫描和公网测试隔离；当前 `.github/` 工作流已删除。
- [x] 删除旧 `data/hot-searches.json`；运行时热搜只使用 SQLite。

---

## 3. 架构与搜索生命周期

```text
浏览器
  └─ /api/search（一次请求）
       ├─ 搜索范围/参数校验与实例级准入
       └─ SearchService
            ├─ Telegram 频道：直连 HTML → 固定 Jina fallback → Parser Plugin（可选）
            └─ Plugin Registry
                 ├─ 内置 Code Plugin
                 ├─ 上游目录转换的 Instructions Plugin
                 └─ 管理员发布的 Instructions Plugin

管理员 /admin
  ├─ SQLite 上游目录、插件仓库、Parser Plugin、密钥、TG 设置
  ├─ 发布/停用/回滚后刷新 Registry
  └─ /api/monitor 聚合上游与 TG 健康视图
```

1. `composables/useSearch.ts` 保存请求序号、AbortController、暂停状态和原始搜索快照，旧请求不能覆盖新请求。
2. `server/utils/searchRequest.ts` 统一 GET/POST 校验；`server/utils/sendSearchStream.ts` 统一发送 SSE，`executeSearch.ts` 负责搜索参数与服务调用。
3. `server/core/services/searchService.ts` 获取 Registry 快照，调度 Telegram 和插件，合并并按时间降序排序，失败来源进入 warning。
4. 插件只通过只读 `PluginSearchContext` 获取关键词、超时、取消信号和扩展参数，不在实例上保存请求状态。
5. 动态上游配置变化通过目录版本和 Registry 检查在下一次搜索前刷新；刷新失败时保留最后一个有效快照。
6. 取消后不再启动排队来源、深搜、关键词变体、分页或组内故障转移；不遵守 AbortSignal 的第三方 CPU 代码无法被强制终止。

### 搜索请求边界

- 关键词：去空白后 1–100 个字符。
- 用户频道：最多 50 个，API 只接受规范化公开用户名；`channels_mode=only` 且为空时返回 400。
- `conc`：1–16 的整数；服务内部实际并发还会受来源调度上限约束。
- `NUXT_SEARCH_TIMEOUT_MS`：默认 30,000 ms，最大 120,000 ms；请求不能通过 `ext` 改写全局预算。
- 搜索接口实例治理：单客户端在途默认 3、实例全局在途默认 16、30 秒窗口默认 30 次；拒绝时返回 429/503 和 `Retry-After`。
- Instructions 单次调用预算：默认最多 7 个请求、16 MiB 传输，stages、主请求和分页共用预算。

---

## 4. 管理控制台与 API

### 4.1 页面入口

- `/admin`：实际管理台。默认显示上游接口；`?view=monitor` 为健康监控，`?view=accounts` 为 TG 账户，`?view=settings` 为搜索设置。
- `/telegram`：独立 TG 诊断页，使用管理员会话。
- `/upstreams`：重定向到 `/admin` 并保留查询参数。
- `/monitor`：重定向到 `/admin?view=monitor`。
- `/tg-accounts`：重定向到 `/admin?view=accounts`。
- 某些旧链接仍会生成 `/admin?view=telegram`，但当前 `pages/admin/index.vue` 没有该视图分支，参数会落回上游接口；TG 频道诊断和管理实际位于 `/telegram`。该兼容链接仍是待修项。

### 4.2 主要 API

- 认证：`GET /api/auth/admin-status`、`POST /api/auth/admin-unlock`、`POST /api/auth/admin-lock`。
- 搜索：`GET/POST /api/search`，响应固定为 SSE。
- 上游目录：`GET/PUT /api/settings/upstreams`，以及 `/api/settings/upstreams/:id` 的删除、启停、导入导出接口。
- 搜索设置：`GET/PUT /api/settings/search`。
- TG 设置和诊断：`GET/PUT /api/settings/telegram`、`GET/PUT /api/settings/tg-source`、`POST /api/tg/probe`、`POST /api/tg/validate-channel`、`/api/tg/channels/**`、`/api/tg/accounts/**`、`/api/tg/mtproto/**`。
- 来源配置统一使用 `/api/settings/upstreams`；旧 Instructions 生命周期接口已删除。
- Parser Plugin：`/api/parser-plugins` 及其 `test/publish/disable/enable/rollback/archive/restore/import/export` 子接口。
- 健康与监控：`GET /api/health`、`GET /api/plugin-health`、`GET /api/monitor`。

所有管理接口使用独立 `ADMIN_PASSWORD` 和 `panhub_admin` Cookie；未配置管理员密码时返回 503。管理写操作执行同源校验，敏感接口还有更严格的单实例限流。

---

## 5. 配置、存储与安全

### 5.1 SQLite

默认数据库为 `data/panhub.sqlite`，使用 `better-sqlite3`、WAL 和 busy timeout。当前命名空间包括：

| 命名空间 | 内容 |
|---|---|
| `upstream_catalog` | 系统/自定义上游目录、配置版本和垃圾箱关联状态 |
| `plugin_repository` | Instructions 定义、版本和生命周期审计 |
| `parser_plugins` | Parser Plugin 定义、版本和发布状态 |
| `search_settings` | 搜索来源、并发、超时和垃圾箱设置 |
| `tg_channel_settings` | TG 频道清单、策略、停用/删除状态和解析器绑定 |
| `tg_accounts` | Telegram 账户配置与会话相关状态 |
| `plugin_health` / `tg_channel_health` | 上游/频道健康快照和有限历史 |
| `hot_searches` | 热搜词和使用次数 |

数据库文件包含敏感配置，不应提交 Git。备份时复制完整 SQLite 数据库，不要只复制 `-wal` 或 `-shm`；恢复建议停止实例后替换数据库再启动。

SQLite 结构化表是唯一持久化源；不再读取旧 JSON、`json_store` 或通用 KV 配置。

### 5.2 管理认证

- `ADMIN_PASSWORD` 与搜索密码 `SEARCH_PASSWORD` 完全独立。
- 管理 Cookie 有效期 8 小时，`HttpOnly; SameSite=Strict`，HTTPS 下附加 `Secure`。
- Instructions 只支持显式变量插值，不支持 `eval`、函数表达式、shell、文件访问或读取系统环境变量。
- 出站 URL 默认仅允许 HTTPS；禁止 localhost、环回、私网、链路本地、云元数据和不允许端口；重定向逐跳重新校验。
- Node 出站请求使用已校验 IP 连接，保留 SNI/Host/证书校验；平台不支持钉住时不宣称等价安全能力。

---

## 6. 插件规范摘要

### 6.1 Code Plugin / Manifest

定义位置：`server/core/plugins/manager.ts`。关键字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 全局 ID 与展示名称 |
| `version` | 不可变版本号；同版本不同定义必须拒绝 |
| `kind` | `code`、`instructions` 或 `telegram` |
| `priority` | 数值越大越先进入批次；同优先级并发，低优先级等待 |
| `timeoutMs` / `maxResults` | 单插件时间和结果上限 |
| `upstreamGroup` / `upstreamWeight` | 等价上游分组和加权轮询参数 |
| `outputTypes` / `capabilities` | 输出类型和能力声明 |

发布、停用和回滚会在下一次搜索前原子刷新 Registry；正在执行的搜索继续使用开始时的快照。

### 6.2 Instructions

定义位置：`server/core/instructions/types.ts`、`validator.ts`、`executor.ts`。顶层为 `schemaVersion`、`manifest`、`request`、`response`。

支持：

- `GET`/`POST`、query、JSON/form body、受限 headers、超时、响应/请求大小、重定向策略。
- `{{keyword}}`、`{{page}}`、`{{cursor}}`、`{{limit}}` 和受限密钥变量。
- JSON 点路径、HTML CSS selector、相对链接、链接数组、常量、默认值、简单转换和受限正则。
- 页码分页、HTML 下一页 selector、多阶段 token/buildId 提取；阶段只能访问同域或显式白名单域，并受阶段数/总请求数限制。
- 结果标准化：危险链接协议过滤、空标题丢弃、重复链接去重、时间规范化和结果上限。


### 6.3 Parser Plugin

定义位置：`server/core/parsers/types.ts`、`repository.ts`、`runtime.ts`。Manifest 需要 `id/name/version/format/target/timeoutMs/maxResults`，`format` 为 `html/json/text/auto`，`target` 为 `upstream/telegram/both`。

转换函数可以是：

```js
function transform(payload, $, context) {
  return [{ id: "stable-resource-id", name: "资源标题", description: null, datetime: null, links: [{ url: "https://pan.baidu.com/s/xxx", password: "abcd" }] }];
}
```

- HTML 响应提供 Cheerio `$`；JSON 响应提供已解析对象；文本/Jina 响应提供原始文本；`auto` 按本次响应格式适配。
- 必须返回资源数组；每项使用 `id`、`name`、`description`、`datetime`、`links[]`，且至少包含一个有效链接。来源、频道、插件版本等诊断信息由运行时补齐。
- 代码在受限 VM 中同步执行，超时或异步返回会失败；Parser Plugin 不负责发起网络请求。
- 该能力已有 API 和孤立管理台组件，但尚未成为 `/admin` 的独立导航项，见第 2 节。

---

## 7. 仓库结构、命令与编码约定

### 7.1 目录

- `pages/`、`app.vue`：页面和兼容重定向路由。
- `components/`：通用、admin、monitor、telegram、upstreams 组件。
- `server/api/`：Nitro/H3 API 路由。
- `server/core/`：搜索、插件、Instructions、Parser Plugin、健康、Telegram、缓存、安全和 SQLite。
- `utils/`：系统默认值、平台信息和上游类型/种子。
- `data/`：运行时 SQLite 与 Telegram Session；不要提交运行数据。

### 7.2 命令

```bash
pnpm dev
pnpm build
pnpm preview
pnpm generate
pnpm typecheck
```

默认验证门禁：

```bash
pnpm typecheck
pnpm build
git diff --check
```

### 7.3 约定

- TypeScript/Vue 使用现有 2 空格、分号和双引号风格。
- API 路由使用 HTTP 方法后缀；组件 PascalCase；组合式函数使用 `useXxx.ts`。
- 外部请求必须有超时、取消和失败处理；不要提交密钥、数据库、日志或原始公网报文。
- 提交主题采用 Conventional Commits，例如 `feat:`、`fix:`、`refactor:`、`delete:`。

---

## 8. 文档与无效代码清理记录

- [x] 删除旧 `docs/upstream-console.md`：其入口 `/upstreams`、localStorage 草稿模型和“自定义 URL 只保存不执行”等描述已被当前 `/admin` + SQLite 实现取代。
- [x] 删除 `AGENTS.md`、`CLAUDE.md` 和 `.github/` 工作流；开发规则、命令和发布门禁统一在本文与 `package.json`。
- [x] 删除 `pages/ios-test.vue`、`test/tg-parse-test.mjs` 等孤立临时入口。
- [x] 删除豆瓣热榜、图片代理和约 20 个失效/低质量来源；当前内置 Code Plugin 只保留 `hunhepan`、`pansearch`、`duoduo`、`nyaa`。
- [x] 删除 Docker、Docker Compose、Oracle Cloud/OCI（仓库中未发现专用配置）、Vercel 和 Cloudflare 的部署入口与配置；README/TODO 仅保留 Node.js 运行说明。
- [x] 将旧开发说明、搜索范围审查、健康/诊断记录合并为当前文档，删除相互矛盾的历史测试数字和重复 TODO。
- [x] 删除旧 JSON/KV 持久化兼容层、旧迁移环境变量和仓库内个人工具配置。

---

## 9. 本次文档审计依据

本次文档更新以当前工作树为准，重点核对：

- `package.json`：实际可用脚本与依赖。
- `pages/admin/index.vue`、`pages/monitor.vue`、`pages/upstreams/index.vue`、`pages/tg-accounts.vue`、`pages/telegram.vue`：真实页面和重定向关系。
- `server/api/**`、`server/core/**`、`composables/useSearch.ts`：请求协议、管理 API、SQLite、插件、取消和安全边界。

在本次审计中执行并确认：

- 类型检查以当前实际执行结果为准。
- `git status --short`：存在大量既有未提交代码改动；本次只编辑 README/TODO，未重置或覆盖这些代码改动。

## 自动化测试清理

已删除自动化测试代码、样本、配置和测试专用依赖；开发验证使用生产构建和手动功能检查。来源管理中的手动测试/诊断功能仍保留。
