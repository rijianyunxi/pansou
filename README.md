# pansou

`pansou` 是一个 **Rust + Vue 3** 的网盘资源聚合搜索项目。

- 项目根目录是 Rust 应用，不再使用 Nuxt/Nitro。
- 后端使用 Rust 2024、Axum、Tokio、SQLx、Reqwest。
- 前端使用 Vue 3、Vue Router、Vite，保持纯 SPA。
- PostgreSQL 保存业务数据、配置、搜索日志和监控数据。
- Redis 保存登录会话、匿名会话、微信扫码登录临时状态、限流计数、搜索并发许可和 TG 本地查询缓存。
- 原来的 `transform(payload, $, context)` 已重构为 Rust 原生 JSON DSL，运行时不执行 JavaScript，也不保留旧 transform 兼容层。

## 1. 总体架构

```mermaid
flowchart LR
    U[浏览器] -->|开发环境 :5173| V[Vite Dev Server]
    V -->|/api 代理| A[Rust / Axum :3666]
    U -->|生产环境静态文件和 /api| A

    A --> PG[(PostgreSQL 18)]
    A --> R[(Redis 8)]
    A -->|仅非 TG 实时搜索| S[外部资源源]
    W[Rust worker] --> P
    P --> T[公开 TG 频道]
    W -->|消息元数据 / 统一 DSL / 资源 / 进度| PG
    A --> P[代理路由 / 代理组 / 代理节点]
    P --> S

    A -->|frontend/dist| SPA[Vue 3 SPA]
```

### 开发环境

```text
Browser -> http://127.0.0.1:5173
                 |
                 | /api、/robots.txt、/sitemap.xml
                 v
          http://127.0.0.1:3666
                 |
                 +--> PostgreSQL
                 +--> Redis
                 +--> 外部资源源/代理节点
```

Vite 只负责前端开发和接口转发，代理目标固定为 `http://127.0.0.1:3666`；无需配置额外的 API Origin，也不在前端保存任何数据库环境变量。

### 生产环境

前端执行 `npm run build` 后生成 `frontend/dist/`。Rust 服务会直接提供：

- `/assets/*`
- `/favicon.ico`
- `/og.svg`
- Vue Router history fallback：其他非 API 路径返回 `frontend/dist/index.html`
- `/api/*`：Axum 显式注册的 API

因此生产环境由 Rust API 进程提供 Web；默认启动同时运行 TG 采集及链接后台任务，不需要 Nuxt 服务，也不需要单独的 Node.js Web 服务。

## 2. 技术栈

| 层级 | 技术 | 职责 |
| --- | --- | --- |
| 前端 | Vue 3.5、Vue Router 4、Vite 7、TypeScript | 搜索页面、结果展示、后台管理 SPA |
| API | Rust 2024、Axum 0.8、Tokio | HTTP 路由、鉴权、搜索编排、后台管理 |
| HTTP 客户端 | Reqwest + Rustls | 请求外部资源源和代理节点 |
| 数据访问 | SQLx 0.8 | PostgreSQL 连接池、查询、migrations |
| 数据库 | PostgreSQL 18 | 用户、资源源、代理、策略、日志、监控、后台数据 |
| 临时状态 | Redis 8 | 会话、用户会话反向索引、匿名会话、扫码状态、本地查询缓存 |
| 内容解析 | Serde JSON、scraper、regex、chrono | Rust 原生 JSON/HTML/TSON/Telegram 数据解析 |
| 日志 | tracing、tower-http TraceLayer | 应用日志与 HTTP 请求日志 |

## 3. 项目目录

```text
pansou/
├─ Cargo.toml                    # Rust crate、依赖和 release 编译配置
├─ Cargo.lock                    # Rust 依赖锁定
├─ .env                          # 本机后端运行配置，不提交敏感信息
├─ .env.example                  # 后端环境变量示例
├─ docker-compose.yml            # PostgreSQL 18 + Redis 8
├─ README.md
│
├─ migrations/
│  ├─ 001_init.sql               # 初始 PostgreSQL 表、约束和基础索引
│  ├─ 002_storage_optimizations.sql # pg_trgm 和查询优化索引
│  ├─ 003_telegram_index.sql        # 频道、任务、消息、资源关联、grams 与缓存版本
│  ├─ 004_crawl_scheduling.sql      # 增量与编辑复查调度；资源删除墓碑
│  ├─ 005_crawl_single_channel.sql  # 多 worker 同频道单运行任务约束
│  ├─ 006_crawl_workbench.sql       # 配置归属、出站策略、单条重解析
│  ├─ 007_workbench_write_guards.sql # 模板版本、任务幂等标识
│  ├─ 008_weighted_nodes_and_query_optimization.sql # 节点优先权重、差量索引
│  └─ 009_name_only_search_index.sql # 仅标题匹配、标题索引重建
│
├─ src/
│  ├─ main.rs                    # 启动入口：配置、数据库、Redis、HTTP 监听
│  ├─ app.rs                     # AppState、所有显式 Axum 路由、SPA 静态托管
│  ├─ db.rs                      # PostgreSQL 连接池、migrations、初始管理员
│  ├─ redis_store.rs             # Redis ConnectionManager、超时、重连、PING
│  ├─ auth.rs                    # Cookie、匿名/登录会话、密码、会话撤销
│  ├─ error.rs                   # API 错误到 HTTP/JSON 的统一映射
│  ├─ models.rs                  # 搜索、来源、用户等 Rust 数据模型
│  ├─ transform.rs               # Rust 原生 transform DSL 和来源解析器
│  ├─ resource_clean.rs          # 共享字段清洗、分享身份、提取码与中文 grams
│  ├─ telegram.rs                # 公开频道身份、消息、实际分页游标
│  ├─ crawl.rs                   # 持久任务、代理采集、租约、幂等入库
│  ├─ outbound.rs                # 唯一策略、节点调度、额度原子预留
│  ├─ migration_preflight.rs     # 只读迁移预检
│  ├─ local_index.rs             # 授权范围内批量 PostgreSQL 查询 + Redis 缓存
│  ├─ telegram_tests.rs          # 需显式启用的隔离集成回归
│  ├─ handlers.rs                # handler 模块声明与统一导出
│  └─ handlers/
│     ├─ common.rs               # 通用响应、管理员鉴权、公开策略映射
│     ├─ public.rs               # health、热搜、运行监控、robots、sitemap
│     ├─ account.rs              # 登录、退出、会话、个人资料、微信、频道
│     ├─ settings.rs             # 搜索设置、资源源、模板、策略、云盘设置
│     ├─ search.rs               # 搜索编排、代理选择、来源执行、SSE/JSON
│     ├─ crawling.rs             # TG 采集管理、取消、重试和已存资源查看
│     └─ admin.rs                # 后台资源、代理、日志、用户、热搜等接口
│
├─ frontend/
│  ├─ package.json               # Vue/Vite 依赖与 npm scripts
│  ├─ vite.config.ts             # Vue 插件、别名、开发接口代理
│  ├─ index.html                 # SPA HTML 入口
│  ├─ app.vue                    # 全局应用外壳、导航、弹层与公共状态
│  ├─ src/
│  │  ├─ main.ts                 # Vue 初始化和显式前端路由
│  │  └─ appRuntime.ts           # 轻量运行时：配置、共享状态、API fetch、head
│  ├─ pages/
│  │  ├─ index/index.vue         # 搜索首页和展示状态编排
│  │  ├─ copyright.vue
│  │  └─ admin/                  # 后台管理各页面
│  ├─ components/
│  │  ├─ home/                   # 首页搜索区、结果区
│  │  ├─ admin/                  # 后台通用组件
│  │  ├─ monitor/                # 运行监控组件
│  │  └─ sources/                # 实时来源编辑与调试组件
│  ├─ composables/
│  │  ├─ useAuth.ts              # 前端会话和用户状态
│  │  ├─ useSearch.ts            # 搜索请求、SSE、暂停/继续、结果状态
│  │  └─ useSettings.ts          # 搜索设置和自定义频道
│  ├─ shared/                    # API 类型、云盘类型、公共常量
│  ├─ utils/
│  │  ├─ searchEventStream.ts    # SSE 字节流解析
│  │  ├─ resultMerge.ts          # 按分享链接去重和合并
│  │  ├─ resultDisplay.ts        # 多链接资源拆成单链接展示卡片
│  │  └─ sourceAdapter.ts        # 云盘类型和 URL 识别辅助
│  ├─ assets/                    # 样式
│  └─ public/                    # favicon、OG 图片等静态资源
│
├─ logs/                         # 本地运行日志目录
└─ target/                       # Cargo 编译产物
```

`target/`、`frontend/node_modules/`、`frontend/dist/` 都是生成目录，不属于业务源码。

## 4. Rust 服务启动流程

`cargo run` 后，`src/main.rs` 按以下顺序启动：

1. 读取项目根目录 `.env`。
2. 初始化 `tracing` 日志。
3. 读取 `PANSOU_DATABASE_URL` 和 `PANSOU_REDIS_URL`。
4. 创建 PostgreSQL 连接池：
   - 设置 `application_name=pansou-api`；
   - 配置最小/最大连接数；
   - 配置 acquire、idle、max lifetime；
   - 借出连接前执行健康检查。
5. 通过 `sqlx::migrate!("./migrations")` 自动执行未应用的 migrations。
6. 检查管理员账号；不存在时创建 `admin`。
7. 创建 Redis `ConnectionManager`，执行 `PING` 验证连接。
8. 创建共享 `AppState`：
   - `PgPool`；
   - `RedisStore`；
   - 全局复用的 `reqwest::Client`。
9. 构造所有显式 Axum 路由。
10. 监听 `PANSOU_API_HOST:PANSOU_API_PORT`，默认端口为 `3666`。

服务启动时 PostgreSQL 或 Redis 不可用会直接启动失败，不会带着残缺依赖继续运行。

## 5. 后端模块关系

```mermaid
flowchart TD
    MAIN[src/main.rs] --> DB[src/db.rs]
    MAIN --> REDIS[src/redis_store.rs]
    MAIN --> APP[src/app.rs]

    APP --> AUTH[src/auth.rs]
    APP --> HANDLERS[src/handlers/*]
    HANDLERS --> MODELS[src/models.rs]
    HANDLERS --> PG[(PostgreSQL)]
    HANDLERS --> AUTH
    HANDLERS --> SEARCH[handlers/search.rs]
    SEARCH --> TRANSFORM[src/transform.rs]
    SEARCH --> HTTP[Reqwest Client]
    AUTH --> REDISDB[(Redis)]
    AUTH --> PG
```

### `AppState`

每个请求共享同一个 `Arc<AppState>`：

```text
AppState
├─ PgPool              PostgreSQL 连接池
├─ RedisStore          可克隆的 Redis ConnectionManager
└─ reqwest::Client     外部来源请求客户端
```

不会为每次请求重新创建数据库连接池、Redis Client 或 HTTP Client。

### 路由原则

所有 `/api/*` 接口都在 `src/app.rs` 中显式注册，不再使用 `/api/{*path}` 动态分发。

未知 API：

```text
/api/does-not-exist -> JSON 404
```

不会错误落到 Vue SPA 的 `index.html`。

## 6. PostgreSQL 与 Redis 的职责

### PostgreSQL：持久业务数据

主要数据表：

| 表 | 用途 |
| --- | --- |
| `resource_sources` | 外部资源源 URL、请求配置、transform DSL、优先级和启停状态 |
| `source_template_settings` | TG 默认解析模板及乐观版本 |
| `source_health` | 来源成功率、耗时、失败次数、最近执行结果 |
| `proxy_nodes` | 代理节点、额度、熔断和最近状态 |
| `outbound_policies` | 实时来源 / TG 频道 / TG 默认策略的唯一配置和版本 |
| `outbound_policy_nodes` | 节点勾选和随机分配权重；节点删除受引用保护 |
| `users` | 用户、管理员、角色、状态、自定义频道 |
| `auth_identities` | 微信等外部身份与本地用户的绑定 |
| `search_logs` | 搜索关键词、范围、来源、结果数、状态和时间 |
| `hot_searches` | 热搜词、分数、审核状态和置顶状态 |
| `managed_resources` | 人工资源和 TG 采集资源的统一库（来源与可见性分开） |
| `policy_settings` | 匿名频道、热搜、认证按钮等策略 |
| `search_settings` / `system_settings` | 搜索并发、超时等系统设置 |
| `cloud_account_settings` | 云盘账号凭证、绑定版本与登录状态 |
| `cloud_provider_policies` | 每个网盘一行的按需转存开关/目录/清理时间与有效性检测参数 |
| `wechat_mini_settings` | 微信小程序配置 |

`002_storage_optimizations.sql` 启用 `pg_trgm`，并为日志关键词、资源搜索、热搜、代理路由、用户列表等查询建立 B-tree、GIN 和部分索引。

### Redis：临时状态和会话

主要 Key：

```text
pansou:session:{token}           -> user_id，登录会话，TTL 由 sessionDays 决定
pansou:anon:{token}              -> 匿名会话标记，TTL 由 sessionDays 决定
pansou:anon_channels:{token}     -> 匿名会话的自定义频道，TTL 由 sessionDays 决定
pansou:user_sessions:{user_id}   -> 当前用户所有 token 的 Set
pansou:rate:search:*             -> 搜索 Session/IP/网段固定窗口计数
pansou:concurrency:search:*      -> Session 和全站搜索并发许可，异常退出由 TTL 回收
```

微信扫码登录还会使用 Redis 保存短期二维码状态。

登录时使用原子 pipeline 同时写入 session 和用户会话反向索引；管理员撤销某用户全部会话时直接读取该用户的 token Set，不需要全库 `SCAN`。

TG 搜索结果使用 Redis 的版本化短期缓存。仅纯非 TG 查询可使用原 Rust 进程内有界 LRU，`cacheTtlMinutes` / `cacheMaxMemoryMb` 控制该缓存；带 TG 的查询不使用旧进程缓存。Redis 同时保存会话、匿名频道、扫码状态、分布式限流和并发许可；持久资源、来源、日志、监控仍以 PostgreSQL 为准。

## 7. 用户从打开页面到看到结果的完整流程

### 7.1 页面初始化

用户打开 `/` 后：

1. `frontend/src/main.ts` 创建 Vue 应用和 Vue Router。
2. 首页 `frontend/pages/index/index.vue` 挂载。
3. `useAuth.initializeSession()` 请求 `/api/account/session`：
   - 浏览器自动携带 `pansou_session` HttpOnly Cookie；
   - 后端从 Redis 校验登录或匿名会话；
   - 没有有效 Cookie 时，只有该接口可以创建匿名 Session；
   - 创建成功后通过 `Set-Cookie` 写入 `HttpOnly` 的 `pansou_session`。
4. `useSettings.syncWithSession()` 加载当前会话可用的搜索设置和自定义频道。
5. 如果后台策略允许显示热搜，页面请求 `/api/hot-searches`。
6. 如果 URL 是 `/?q=关键词`，初始化完成后自动执行该关键词搜索。

### 7.2 用户提交搜索

首页先检查：

- 会话是否初始化完成；
- 设置是否加载完成；
- 关键词是否非空；
- 当前是否已有搜索正在进行；
- 自定义频道模式下是否至少配置了一个频道。

默认系统来源模式发送：

```http
POST /api/search
Content-Type: application/json
Accept: text/event-stream
Cookie: pansou_session=...

{
  "kw": "搜索关键词"
}
```

自定义频道模式发送：

```json
{
  "kw": "搜索关键词",
  "channels": ["channel_a", "channel_b"]
}
```

`channels` 在请求中只表示选择“自定义频道模式”。Rust 不信任客户端提交的频道内容：登录用户从 PostgreSQL 的账号记录读取，匿名用户从当前 Redis 会话读取，因此无法临时注入未保存频道。

`source_ids` 和 `conc` 也属于后端搜索模型，但普通首页目前不主动发送：

- `source_ids`：限制本次执行的来源；
- `conc`：本次并发数，执行时限制在 `1..=32`；未传时使用 `user-policy.defaultConcurrency`，后台策略允许配置 `1..=16`，默认 `4`。

### 7.3 会话校验和搜索日志开始

`handlers/search.rs::search_sse` 收到请求后：

1. 通过 Redis 严格校验 `pansou_session`；缺失、过期或伪造的 Session 返回 HTTP `401` 和 `SESSION_REQUIRED`，搜索接口不会隐式创建 Session。
2. 校验 `kw` 去除首尾空白后长度必须为 `1..=100` 个字符。
3. 自定义频道模式从 PostgreSQL 或 Redis 重新读取当前会话已保存的频道，并执行匿名权限和频道数量校验。
4. 按登录/匿名策略原子消费 Redis 中的 Session、IP 和网段搜索额度；任一额度超限返回 HTTP `401` 和 `SEARCH_LIMIT_EXCEEDED`。
5. 获取 Session 级和全站搜索并发许可；Session 并发超限返回 HTTP `401` 和 `SEARCH_LIMIT_EXCEEDED`，全站并发超限返回 HTTP `503` 和 `SERVER_BUSY`。
6. 向 PostgreSQL `search_logs` 插入 `started` 记录，包含：
   - session token；
   - user id；
   - keyword；
   - client IP；
   - 搜索范围；
   - 自定义频道；
   - 指定来源。
7. 日志写入失败只记录 warning，不阻断真实搜索。

### 7.4 加载本次要执行的来源

系统来源模式：

```sql
SELECT ...
FROM resource_sources
WHERE enabled = true
ORDER BY priority, id
```

如果传入 `source_ids`，则只选择指定且已启用的来源。

自定义频道模式还会读取 `source_template_settings`，使用模板中的 Rust DSL，并使用规范公开频道 URL，为每个频道生成一个本地查询来源（不会在搜索时联网）：

```text
channel:{channel_name}
```

### 7.5 并发执行来源

后端通过：

```rust
buffer_unordered(concurrency)
```

并发执行多个来源。默认并发数由 `user-policy.defaultConcurrency` 决定（默认 `4`），单次执行最大 `32`。

来源先划分为 TG 本地查询和非 TG 实时查询。TG 一次批量查 PostgreSQL/Redis，非 TG 由 `execute_source()` 并发执行；两条结果流合并，谁先完成谁先推送。非 TG 单源失败不阻断其他来源；本地数据库故障返回明确错误，不悄悄回退联网。

以下请求构造与代理步骤只用于非 TG 实时搜索和后台采集。

### 7.6 构造来源请求

每个来源配置包含：

```text
id
name
description
url
method
format
priority
enabled
request_json
transform
```

Rust 会：

1. 用关键词替换来源 URL 中的 `{{keyword}}`。
2. 渲染 `request_json.query` 中的 `{{keyword}}`。
3. 渲染 `request_json.body` 中所有层级的 `{{keyword}}`。
4. 加入来源自定义 headers。
5. 根据 `method` 发送 GET 或 POST。
6. 根据 `format` 设置 JSON 或 HTML 的 `Accept`。

### 7.7 业务对象出站策略

```text
实时来源 / TG 频道 / TG 默认配置
    -> outbound_policies（唯一所有者）
        -> outbound_policy_nodes（按正权重随机分配）
            -> proxy_nodes（全局健康、额度）
```

1. 来源和 TG 频道勾选节点、填权重（0～10000），每次请求按正权重加权随机选择。例如 20/20/10 的三个可用节点，长期首选比例约为 40%/40%/20%，不是固定优先顺序。权重 0 完全不参与，也不作为失败兜底；至少一个选中节点的权重必须大于 0。
2. 直连是受保护的内置节点 `direct`，与代理采用相同的权重规则。只有勾选且权重大于 0 才能直连，没有隐式直连回退。
3. 不可用代理在发送前跳过；可恢复失败在未尝试的节点中重新按权重选择，每个正权重节点最多尝试一次，共享总超时预算；429不轮换绕过限制。额度和健康变化会影响实际占比，界面占比仅按配置计算。
4. 代理全局额度和半开探测仍原子预留；直连不占代理额度，不能编辑、停用或删除。
5. POST只发送一次，避免重复提交。不再有 replaySafe、maxAttempts 等配置。
6. 转发协议仍为 {base_url}/{percent-encoded-target-url}；尝试统计保持 nodeId/nodeName/status/httpStatus/elapsedMs/attempt。TG本地搜索不联网，采集诊断在工作台查看。
7. 自动登记频道可以使用TG默认节点；缺失时失败关闭。编辑其节点即独立保存，没有复杂模式选择。

### 7.8 Rust 原生 transform 解析

来源响应读取为文本后进入：

```rust
transform::apply(transform, payload, format, keyword, source_id)
```

`transform` 必须是 JSON DSL，例如：

```json
{
  "kind": "json",
  "items": "$.data[*]",
  "fields": {
    "id": "id",
    "name": "title",
    "description": "description",
    "datetime": "datetime",
    "links": "links",
    "tags": "tags",
    "images": "images"
  },
  "limit": 200
}
```

HTML 来源示例：

```json
{
  "kind": "html",
  "item_selector": "article",
  "fields": {
    "name": ".title",
    "description": ".description",
    "datetime": "time::datetime",
    "links": "a.share::href",
    "images": "img.cover::src"
  }
}
```

解析器负责：

- JSON 路径取值；
- HTML CSS selector 和属性提取；
- PanSearch 页面数据提取；
- xiaokupan TSON 解码；
- 玩偶等 VOD 数据映射；
- Telegram 文本中的名称、描述和链接拆分；
- 统一时间格式；
- 过滤非资源链接和 Telegram 页面链接；
- 根据 URL 推断 `baidu`、`quark`、`aliyun`、`mobile` 等云盘类型；
- 生成稳定 ID；
- 单来源结果去重和数量限制。

统一结果模型：

```json
{
  "id": "source-stable-id",
  "name": "资源名称",
  "description": "资源描述",
  "datetime": "2026-09-29 12:00:00",
  "cloud_types": ["quark"],
  "links": [
    {
      "type": "quark",
      "url": "https://pan.quark.cn/s/example",
      "password": null
    }
  ],
  "tags": [],
  "images": []
}
```

### 7.9 来源统计和运行监控

每个来源执行完成后会生成 `SourceMeta`：

```json
{
  "id": "pansearch",
  "name": "PanSearch",
  "priority": 0,
  "status": "success",
  "resultCount": 8,
  "elapsedMs": 1661,
  "transformMs": 16,
  "proxyNodes": [],
  "results": []
}
```

同时更新 PostgreSQL `source_health.snapshot_json`，记录：

- 请求数；
- 成功和失败次数；
- 连续失败次数；
- 零结果次数；
- 平均响应时间；
- 最近执行结果；
- 最近错误信息。

后台运行监控页面通过管理员接口 `/api/monitor` 展示 API / PostgreSQL / Redis 状态、TG 与链接服务心跳、任务队列、最近 24 小时点击交付结果和实时来源统计。TG 搜索身份不再混入实时来源健康统计。TG 调度与到期清理可以分别暂停，开关存入 PostgreSQL `policy_settings.background-workers`，默认启用；暂停在当前批次完成后生效，重启保留。兼容旧字段 `linkEnabled`，但其含义现仅为到期清理应急开关（接口 `/api/admin/runtime/workers/cleanup`）；资源链接同步、状态汇总与按需取链不受该清理独立开关影响。链接任务总调度开关 `linkScheduleEnabled` 则同时控制资源链接同步、定期检测、到期清理和过期与超时处理；暂停后项目、搜索和用户复制/打开仍可运行，按需转存仍按网盘配置执行，后台清理会延后。旧的显式暂停不会被自动恢复。

「系统 → 网盘账号」集中管理五家网盘的扫码连接、凭证维护、按需转存与有效性检测，系统设置只保留跳转入口。阿里、光鸭令牌支持自动续期，百度、夸克维护 Cookie 并定期检查；迅雷暂用高级导入。凭证在服务端加密保存，首次保存生成的密钥文件需与数据库一同备份。详见 [网盘账号管理](docs/cloud-accounts.md)。页面不再分页签：每家网盘是一张卡片，上半部分管理授权，下半部分展示转存与检测状态；卡片上的「转存」按钮打开配置弹窗，设置按需转存开关、项目专用目录（不能选根目录）、清理时间、平台分享期限，以及检测间隔、每日额度与缓存参数，弹窗的「转存」保存生效、「清除」关闭并清空转存配置。每个网盘的配置存在 `cloud_provider_policies` 一行里（迁移 026 从原 `link-delivery` / `link-check` JSON 搬运并删除旧键），`link-check` 只保留后台检测总开关。转存仅在用户复制/打开时发生，没有定时批量转存；关闭转存不取消既有产物的清理，也不禁止复用仍可用的自产分享。后台巡检独立控制，关闭只停止批量检测，保存检测参数不会改变启停状态。

入库只解析并记录链接，通过本地 outbox 异步关联与排队检测，不阻塞采集。`validity=1` 表示明确有效，`0` 仅表示原分享明确失效/资源不存在，`-1` 表示未知：网络、登录、限频、密码或接口错误均覆盖当前有效性为 `-1`，不会沿用旧的 `0/1`。后台巡检跳过未配置凭据或仍在检测缓存/退避期的链接，优先新入库与最近被点击的链接；每网盘每日原链检测预算至少保留 20% 给点击请求。

点击时先检查原始分享身份及提取码指纹、当前凭据指纹和目标目录对应的自产映射，不按标题猜测已有文件。可用自产分享优先返回，原分享失效不会覆盖它；不存在可用产物时，核验原分享后才创建独立子目录、转存与分享。除明确原分享失效/资源不存在之外，其他失败返回原链接及提取码。复用不延长保留期，配置修订也不重置已有产物的保留时间。到期仅撤销记录在案的自产分享并清理归属与完整文件树均核实的流程子目录；内容被人工修改或写入状态不确定时阻塞清理，不盲目删除。

### 7.10 后端聚合和去重

所有来源完成后，后端：

1. 收集所有来源结果。
2. 以排序、去重后的规范分享身份集合生成跨来源去重键；保留移动云盘有效 hash。
3. 没有链接时使用结果 ID。
4. 保留第一次出现的结果。
5. 按来源 `priority` 排序统计信息。
6. 生成总结果数和来源统计。
7. 更新 `search_logs`：
   - `status=completed`；
   - `result_count`；
   - `has_results`；
   - 每个来源结果数；
   - 实际来源 ID；
   - `completed_at`。

如果搜索主流程返回错误，则把日志状态更新为 `failed`。

### 7.11 SSE 返回

`POST /api/search` 返回 `text/event-stream`：

```text
id: 1
event: start
data: {"intervalMs":16,"searchLogId":42}

id: 2
event: result
data: {"results":[...]}

id: 3
event: complete
data: {"total":54}
```

SSE 对外字段与 `main` 分支保持一致：

- `start` 只包含 `intervalMs` 和 `searchLogId`；
- `result` 只包含公开的 `results`，不会暴露 `sourceId`、`plugin` 或其他来源内部身份；
- `complete` 只包含最终 `total`；
- 每个事件包含递增的 SSE `id`；
- 响应设置 `Cache-Control: private, no-store, no-transform` 和 `X-Accel-Buffering: no`。

后端启动所有来源的并发执行后，哪个来源先完成，就立即发送哪个来源的一个 `result` 事件；首个来源结果立即发送，后续来源事件按 FIFO 顺序并保证至少约 16ms 的发送间隔。所有来源完成后才聚合最终结果、完成搜索日志并发送 `complete`。

来源返回的 `plugin:*` tag 属于内部运行元数据，会在 Rust transform 输出阶段删除，不进入公开的 `SearchResult.tags`。

### 7.12 前端消费、合并和展示

`frontend/composables/useSearch.ts`：

1. 使用 `fetch()` 请求 `/api/search`。
2. `searchEventStream.ts` 从 `ReadableStream` 解析 SSE block。
3. 收到 `start` 保存 `searchLogId`。
4. 收到 `result` 把新结果合并到现有状态。
5. 收到 `complete` 标记搜索完成。
6. 处理 `401`、`403`、`503` 和普通错误；`SESSION_REQUIRED` 会触发一次 Session 重建，`SEARCH_LIMIT_EXCEEDED` 不会被误判成登录失效。
7. 使用 `AbortController` 支持取消、暂停和离开页面时中断请求。

前端增量合并不是按来源 ID，也不是按结果 ID，而是按**分享链接 URL**：

```text
同一个分享 URL -> 同一个资源组
```

合并时：

- URL 去掉 hash；
- hostname 转小写；
- 处理末尾 `/`；
- 合并密码、云盘类型、tags 和 images；
- 优先保留最早结果的稳定 ID 和名称；
- 后到的非空描述和时间可以补全现有结果。

### 7.13 从资源模型到页面卡片

API 中一个资源可以有多个分享链接：

```text
一个 SearchResult
├─ 百度链接
├─ 夸克链接
└─ 移动云盘链接
```

`frontend/utils/resultDisplay.ts` 只做 UI 投影，把它拆成三个单链接展示项：

```text
API 层：一个资源，多条 links
展示层：一张卡片只展示一条 link
```

这不会修改原始 API 数据，只影响页面渲染。

首页随后计算：

- 可用云盘平台列表；
- 每个平台结果数量；
- 当前平台筛选；
- 默认顺序、时间升序或时间降序；
- 搜索中保持到达顺序，搜索完成后再应用用户选择的排序。

时间字符串由前端按 `Asia/Shanghai` 的 `+08:00` 解析，避免浏览器把无时区字符串按不同本地时区解释。

最后 `HomeResultsPanel` 和 `ResultGroup` 渲染：

- 资源名称；
- 发布时间；
- 可展开描述；
- 云盘类型；
- 分享链接；
- 提取码；
- 打开和复制操作。

## 8. 搜索时序图

```mermaid
sequenceDiagram
    participant U as 用户
    participant F as Vue SPA
    participant A as Axum API
    participant R as Redis
    participant P as PostgreSQL
    participant X as 外部来源/代理

    U->>F: 输入关键词并搜索
    F->>A: POST /api/search + Cookie
    A->>R: 校验登录/匿名会话
    R-->>A: 会话有效
    A->>P: INSERT search_logs(status=started)
    A->>P: 读取授权来源
    A->>R: TG 本地查询缓存（包含范围和数据库版本）
    R-->>A: 命中则返回；未命中回源 PostgreSQL
    A->>P: 批量检索 TG 资源与授权 occurrence
    P-->>A: 本地资源批次
    A-->>F: SSE result（不等待非 TG 来源）

    par 多来源并发执行
        A->>X: 代理或直连请求来源 A
        X-->>A: JSON/HTML/TSON
        A->>A: Rust transform 解析
        A->>P: 更新 source_health
    and
        A->>X: 代理或直连请求来源 B
        X-->>A: JSON/HTML/TSON
        A->>A: Rust transform 解析
        A->>P: 更新 source_health
    end

    A->>A: 按返回顺序追加结果（服务端不做搜索去重）
    A->>P: UPDATE search_logs(status=completed)
    A-->>F: SSE start
    A-->>F: 某个来源完成后立即发送 SSE result
    A-->>F: SSE complete
    F->>F: 按链接合并、拆成单链接卡片
    F-->>U: 筛选、排序并展示结果
```

## 9. JSON 搜索接口

除首页使用的 SSE 接口外，还提供：

```http
GET /api/search/json?kw=关键词
```

返回结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "total": 54,
    "searchLogId": 42,
    "results": [],
    "sources": [
      {
        "id": "pansearch",
        "name": "PanSearch",
        "priority": 0,
        "status": "success",
        "resultCount": 8,
        "elapsedMs": 1661,
        "transformMs": 16,
        "proxyNodes": [],
        "results": []
      }
    ]
  }
}
```

`data.results` 是统一的扁平结果数组：本地采集资源在前，外部实时结果按完成顺序追加。本地 TG 资源不再按频道组装，也不携带 `priority`、`elapsedMs`、`transformMs` 或 `proxyNodes` 等来源执行统计。

`data.sources` 只包含外部实时来源的诊断统计，继续按 `priority` 升序排列；`sources[i].results` 是对应外部来源的原始结果，与统一数组中的外部结果相同，不应再次追加到统一数组。纯本地查询的 `sources` 为 `[]`。

两个搜索接口均先完成本地查询，再启动外部来源。`/api/search` 先推送一个本地 `result` 批次，再逐批推送外部结果；`/api/search/json` 等全部执行完成后返回上述统一结构。TG 未采集或未命中时不会回退到实时 TG 请求，但仍会继续搜索已启用的非 TG 外部来源。

采集入库继续负责本地资源去重，搜索服务端不再进行跨来源去重。`total` 是实际返回的原始资源记录数（包含跨来源重复项），不是全库命中数；前端按链接集合合并重复项，并独立计算展示数量。本地查询只使用带授权范围和索引版本的 Redis 缓存；含本地资源的搜索不会写入或读取外部搜索的进程内聚合缓存。

## 10. API 分组

| 分组 | 主要用途 |
| --- | --- |
| `/api/health` | PostgreSQL、Redis、来源配置健康检查 |
| `/api/search` | 首页 SSE 搜索；必须有有效 Session |
| `/api/search/json` | 带来源统计的 JSON 搜索；仅管理员可访问 |
| `/api/hot-searches` | 公开热搜 |
| `/api/monitor` | 服务、后台任务与实时来源运行监控（管理员） |
| `/api/account/*` | 会话、登录、退出、资料、微信、频道 |
| `/api/settings/*` | 搜索、来源、模板、策略和云盘设置 |
| `/api/admin/resources/*` | 后台资源管理 |
| `/api/admin/proxies/*` | 代理节点、代理组和代理路由 |
| `/api/admin/search-logs` | 搜索日志 |
| `/api/admin/search-analytics` | 搜索统计 |
| `/api/admin/hot-searches/*` | 热搜管理 |
| `/api/admin/users/*` | 用户和用户会话管理 |
| `/api/sources/probe` | 管理员调试单个来源 |

`GET/PUT /api/settings/search` 的数据结构为 `{ sources: string[] }`，并以 `resource_sources.enabled` 为唯一运行时真源；并发、超时、缓存、限流和熔断参数统一由 `/api/settings/user-policy` 管理。


### 10.1 Session、限流和并发保护

```text
GET /api/account/session
  -> 有效 Cookie/Bearer：复用现有 Session
  -> 无有效 Session：创建匿名 Session，并设置 HttpOnly Cookie

POST /api/search
  -> 无有效 Session：401 SESSION_REQUIRED
  -> Session/IP/网段搜索额度超限：401 SEARCH_LIMIT_EXCEEDED
  -> Session 并发超限：401 SEARCH_LIMIT_EXCEEDED
  -> 全站并发超限：503 SERVER_BUSY

GET /api/search/json
  -> 仅管理员访问
  -> 无 Session 或匿名 Session：401
  -> 已登录但非管理员：403
```

搜索限流额度来自 `/api/settings/user-policy` 中的匿名/登录策略；网段额度按 IP 额度乘以 `PANSOU_SEARCH_SUBNET_LIMIT_MULTIPLIER` 计算。IPv4 按 `/24`，IPv6 按 `/64` 归一化。限流计数由 Redis Lua 脚本原子更新，避免并发请求分别通过检查后再同时写入。

并发许可同样存放在 Redis：正常完成和提前返回会主动释放，进程崩溃或连接异常时由 TTL 自动回收。该机制用于降低代理轮换、批量 Session 和并发爬取对上游来源及本服务的压力，但不能替代反向代理/WAF 的连接数、带宽和恶意流量防护。

### 10.2 统一前端错误提示

`frontend/src/appRuntime.ts` 会统一解析后端的 `message/statusMessage/code`，并派发 `pansou:api-error`。`frontend/app.vue` 在首页和管理后台都显示全局错误 Toast；搜索结果区域仍会保留与本次搜索相关的具体错误。网络错误、普通 API 失败和管理后台未局部处理的异常不再静默。

管理员接口通过当前会话读取用户，并检查 PostgreSQL 中的 `role=admin`。`/api/search/json` 同样执行该检查：无 Session 或匿名 Session 返回 `401`，已登录但非管理员返回 `403`。

## 11. 本地开发

### 11.1 安装依赖

需要：

- Rust stable，支持 Rust 2024 edition；
- Node.js 和 npm；
- PostgreSQL 18；
- Redis 8。

Windows 安装 Rust 后如果当前 PowerShell 尚未刷新 PATH：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo --version
```

### 11.2 使用 Docker 启动 PostgreSQL 和 Redis

```powershell
cd D:\study\pansou
Copy-Item .env.example .env -ErrorAction SilentlyContinue
docker compose up -d postgres redis
docker compose ps
```

PostgreSQL 和 Redis 的数据分别保存到 `docker-compose.yml` 所在目录下的 `data/postgres/` 和 `data/redis/`，首次启动时自动创建目录。`data/` 已被 Git 忽略，重建容器会继续使用这些数据。已有命名卷的数据不会自动迁移到这些目录；升级旧部署时，需要先备份并迁移数据再切换挂载方式。

### 11.3 启动 Rust

PostgreSQL 与 Redis 的容器参数已直接写死在 `docker-compose.yml`（`shared_buffers 512MB`、`max_wal_size 4GB`、`checkpoint_timeout 15min`、WAL 页图像压缩、Redis `maxmemory 256mb` 及初始化账号），以同机运行 API、PostgreSQL 和 Redis 的 2 核 2 GB 服务器为保守起点，不再读取 `.env`。需要调整时直接修改 `docker-compose.yml` 后执行 `docker compose up -d postgres redis`；`work_mem` 保留 PostgreSQL 默认值。

`shared_buffers` 不是 PostgreSQL 的全部内存占用，连接、排序、维护操作还会使用额外内存；`max_wal_size` 是磁盘 WAL 的软上限，不是内存预留。达到 WAL 阈值仍会提前触发检查点。2 GB 服务器可先将采集并发设为 2、页面等待设为 2 秒，再观察整机内存、CPU 和查询延迟；不要直接沿用高并发历史回填设置。

后台频道列表的消息数和去重资源数使用 PostgreSQL 持久化增量统计，与消息入库、重解析和资源关联变更在同一事务更新；资源停用、软删除即时从统计中排除。首次访问和程序重启不再扫描全量消息/关联表。升级时迁移 `016` 会一次性回填已有数据，回填期间会短暂阻塞采集写入；之后无需定时全量重算。任务状态、失败页数仍实时查询。监控页面的资源总数及链接目录统计共享 30 秒缓存，心跳、任务队列及后台开关仍实时查询。新建/停用/删除资源仍受原有权限和可见性规则约束。

```powershell
cd D:\study\pansou
cargo run
```

默认地址：

```text
http://127.0.0.1:3666
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3666/api/health
```

### 11.4 启动前端

另开一个 PowerShell：

```powershell
cd D:\study\pansou\frontend
npm install
npm run dev
```

开发页面：

```text
http://127.0.0.1:5173
```

## 12. 后端环境变量

所有后端配置都位于根目录 `.env`，前端不保存 PostgreSQL、Redis 或管理员密码。

仓库中的 `.env.example` 是不含真实密钥的默认模板。Release 压缩包只包含 `pansou-api` 二进制、`frontend/dist` 和由模板生成的默认 `.env`，部署辅助文件（`docker-compose.yml`、systemd 服务文件等）不进包，以本仓库和 README 为准；正式部署前请修改数据库密码、管理员初始密码，并不要把修改后的 `.env` 提交到 Git。

| 变量 | 默认/示例 | 用途 |
| --- | --- | --- |
| `PANSOU_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/pansou` | PostgreSQL 连接串 |
| `PANSOU_REDIS_URL` | `redis://127.0.0.1:6379/` | Redis 连接串 |
| `PANSOU_API_HOST` | `0.0.0.0` | Rust 监听地址；使用可信反向代理时可改为 `127.0.0.1` |
| `PANSOU_API_PORT` | `3666` | Rust 监听端口 |
| `PANSOU_ADMIN_INITIAL_PASSWORD` | 空 | 首次创建管理员的密码；为空则随机生成并只输出一次 |
| `RUST_LOG` | `pansou_api=info,tower_http=info` | tracing 日志过滤 |
| `PANSOU_DB_MAX_CONNECTIONS` | `32` | PostgreSQL 最大连接数 |
| `PANSOU_DB_MIN_CONNECTIONS` | `2` | PostgreSQL 最小连接数 |
| `PANSOU_DB_ACQUIRE_TIMEOUT_SECONDS` | `10` | 获取数据库连接超时 |
| `PANSOU_DB_IDLE_TIMEOUT_SECONDS` | `600` | 空闲连接回收时间 |
| `PANSOU_DB_MAX_LIFETIME_SECONDS` | `1800` | 单连接最大生命周期 |
| `PANSOU_REDIS_CONNECTION_TIMEOUT_SECONDS` | `3` | Redis 建连超时 |
| `PANSOU_REDIS_RESPONSE_TIMEOUT_SECONDS` | `5` | Redis 命令响应超时 |
| `PANSOU_TRUST_PROXY_HEADERS` | `false` | 是否信任 `X-Forwarded-For`/`X-Real-IP`；仅当 Rust 只能由可信反向代理访问时开启 |
| `PANSOU_SEARCH_SUBNET_LIMIT_MULTIPLIER` | `4` | 搜索网段额度相对 IP 额度的倍数 |

搜索并发（匿名单会话 / 登录单会话 / 全站）不走环境变量，在 管理后台 → 搜索限流与并发 中配置。

生产环境必须修改默认数据库密码，并根据部署方式决定是否为 Redis 启用密码或 ACL。`PANSOU_TRUST_PROXY_HEADERS=true` 不能单独作为公网配置使用：必须确保客户端无法绕过可信反向代理直连 Rust，否则攻击者可以伪造转发头绕过按 IP/网段统计。

## 13. 构建与运行生产版本

```powershell
cd D:\study\pansou\frontend
npm ci
npm run typecheck
npm run build

cd D:\study\pansou
cargo build --release
.\target\release\pansou-api.exe
```

Linux 二进制默认路径：

```text
target/release/pansou-api
```

Rust 进程的当前工作目录应为项目根目录，因为静态文件路径是 `frontend/dist/*`。

### 13.1 服务器部署（GitHub Release 产物 + systemd）

推送 `v*` 标签后，GitHub Actions 自动构建前端与 x86_64 musl **静态**二进制（不依赖宿主机 glibc，Debian 11 及以上均可直接运行），并把 `pansou-api`、`frontend/dist` 与默认 `.env` 打成单个压缩包，附加到 GitHub Release（附 sha256）。包内只有这三项；`docker-compose.yml`、systemd 服务文件等部署辅助文件从本仓库获取。

首次安装（PostgreSQL/Redis 用本仓库 docker-compose 启动，端口仅绑定 `127.0.0.1`）：

```bash
sudo useradd -r -s /usr/sbin/nologin pansou
sudo mkdir -p /opt/pansou
tar xzf pansou-linux-amd64.tar.gz -C /opt/pansou
# 修改 /opt/pansou/.env（包内 .env 是不含真实密钥的默认配置）：
# PANSOU_DATABASE_URL=postgres://…@127.0.0.1:5432/pansou
# PANSOU_REDIS_URL=redis://127.0.0.1:6379/
```

systemd 服务文件不随包发布，把以下内容写到 `/etc/systemd/system/pansou.service`：

```ini
[Unit]
Description=pansou API (Rust + static frontend)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=pansou
Group=pansou
WorkingDirectory=/opt/pansou
EnvironmentFile=/opt/pansou/.env
ExecStart=/opt/pansou/pansou-api
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo chown -R pansou:pansou /opt/pansou
sudo systemctl daemon-reload
sudo systemctl enable --now pansou
```

日常更新：下载新的 `pansou-linux-amd64.tar.gz`，`tar xzf pansou-linux-amd64.tar.gz -C /opt/pansou` 覆盖二进制与静态文件，然后 `sudo systemctl restart pansou`。数据库迁移在启动时自动执行（`sqlx::migrate!` 嵌于二进制内）；回滚时解压上一版 tar 包再重启即可。

## 14. 测试与质量检查

后端：

```powershell
cd D:\study\pansou
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

前端：

```powershell
cd D:\study\pansou\frontend
npm run typecheck
npm test
npm run build
npm audit
```

当前测试重点覆盖：

- 原动态接口是否已全部改成显式路由；
- 未知 API 是否返回 JSON 404；
- `/api/search/json` 契约和统计字段；
- PanSearch 解析；
- xiaokupan TSON 解析；
- 玩偶 VOD 解析；
- Telegram 名称、描述、链接和时间解析。

## 15. TG 采集与本地搜索

### 启动（项目根目录）

先启动 PostgreSQL 和 Redis，然后启动服务：

~~~powershell
cd D:\study\pansou
cargo run -- serve
~~~

`cargo run` / `cargo run -- serve` 默认同时启动 API、TG 采集和链接后台任务；运行状态及暂停/恢复入口位于 `/admin/monitor`。有效性检测与自动转存仍由各自业务策略控制，不因 Worker 启动而自动开启。

独立部署时设置 `PANSOU_EMBEDDED_WORKERS=false`，分别运行 `pansou-api serve`、`pansou-api worker`、`pansou-api link-worker`。请勿同时重复运行内嵌和独立 Worker。后台任务不监听 HTTP 端口，各进程共用根目录后端配置。Vue 开发服务器仍在 frontend 中执行 npm run dev。

### 采集流程

1. 管理员在 TG 工作台直接维护频道；公共来源身份绑定保留原 source ID。用户保存自定义频道时幂等登记采集意向，不再通过来源列表或定时全表发现同步配置。
2. worker 优先采最新页，默认每 300 秒增量同步。采完最新页后自动启动最多 500 页的首次历史回填。
3. 直接读取公开页的 data-post 消息身份和 tme_messages_more 游标，不假定消息 ID 连续，也不携带用户搜索关键词抓取。
4. worker 使用频道唯一出站策略与统一调度服务；新用户频道可继承显式 TG 默认策略，缺失则阻止网络采集，不能借其他频道策略。任务记录实际节点、耗时及版本。403/404明确失败；429按Retry-After退避，不换代理绕过限制。
5. 原始消息 HTML、hash、发布时间存入 source_messages。同一 Rust transform DSL 提取并清洗标题、简介、网盘链接、密码、标签和时间；不执行 JavaScript。多段明确标题分开解析；高歧义大量链接聚合帖隔离为待复核。
6. 按规范分享集合去重到统一 managed_resources，用 resource_occurrences 保存消息/频道关系，resource_links 保存分享身份，resource_grams 提供中文单字/双字候选索引。
7. 页面资源、关系、解析状态、任务进度、数据库缓存版本在同一事务提交。重复页面不重复造资源；编辑时尽量保留资源 ID；管理员 override 不被后续采集覆盖。
8. 首次自动全量历史采集，无总页数限制，完成后不周期重抓；历史与日常增量游标独立，到期增量穿插执行。全局并发频道数、每页等待、日常间隔可配置；同频道仅一个执行页，租约过期恢复。

### 搜索流程与契约

Session/权限/限流/并发校验 → 服务端计算可见来源 → TG 一次批量本地查询 → Redis 未命中则查 PostgreSQL → 与非 TG 实时来源结果流合并 → 原契约 SSE → Vue 展示。

- 系统 TG 搜索不访问 t.me，未命中不回退联网。用户自定义频道搜索与采集完全独立，仅对本次提交频道实时 HTTP 搜索并使用通用 transform，不查询资源库/结果缓存。
- Redis 正结果 60 秒、空结果 10 秒；key 包含关键词、授权来源集合和 PostgreSQL 索引版本。版本与数据同事务更新，管理员修改/下架立即失效。
- 标题精确命中 > 标题包含 > 简介/标签包含，同级按消息发布时间降序；返回上限 200，SQL 5 秒超时。total 仍是本次返回且去重后的数量，不是全库计数。
- 共享资源从本次允许频道的 occurrence 取展示文本，不泄漏其他个人频道的标题/简介。
- 仅查询缓存失败可回源 PostgreSQL；Redis 会话/安全校验失败仍拒绝请求，不匿名放行。
- /api/search 仍为 start/result/complete/error。纯本地查询通常快速返回；混合查询本地结果不等慢来源。
- /api/search/json 仍仅管理员，返回 total/results/sources/searchLogId；results 为本地优先的扁平资源数组，sources 仅保留外部实时来源统计，TG 不再返回来源 priority 或执行统计。历史采集代理记录只在采集管理展示。
- 前后端只合并完全相同的分享集合，避免合集“桥接”误合并单资源。移动云盘不同 hash 是不同分享。API 仍是一资源多个 links，前端仍拆链接卡片。
- 人工创建的旧资源不自动公开到 TG 搜索；TG 资源删除是软下架，保留采集溯源，避免下次爬取又恢复。

### 后台管理

访问 /admin/crawl，在频道行内查看任务和失败页、勾选批量重抓/忽略，设置三个全局调度参数、暂停/继续采集，并查看消息解析状态和已存资源。采集原文只在解析过程中临时使用，不长期保存；消息原文、摘要和规则预览已删除。接口全部为显式 Axum 路由并要求管理员权限。

~~~text
GET  /api/admin/crawl/channels
PUT  /api/admin/crawl/channels/{channel}
POST /api/admin/crawl/channels/{channel}/jobs
GET  /api/admin/crawl/jobs
POST /api/admin/crawl/jobs/{id}/retry
POST /api/admin/crawl/jobs/{id}/cancel
GET  /api/admin/crawl/channels/{channel}/messages
GET  /api/admin/crawl/channels/{channel}/messages/{id}
~~~

### 隔离集成测试

默认 cargo test 不连接外部数据库。完整测试须提供**专用、可丢弃的测试库**（数据库名以 _test 结尾）及独立 Redis 测试库，禁止指向开发/生产业务库。

~~~powershell
$env:PANSOU_TEST_DATABASE_URL = 'postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/pansou_tg_test'
$env:PANSOU_TEST_REDIS_URL = 'redis://127.0.0.1:6379/15'
cargo test telegram_ingestion_search_and_admin_contracts -- --ignored --nocapture
~~~

测试使用本地 mock 代理，不依赖 Telegram 网络。覆盖分页、重复入库、消息编辑/分享替换稳定 ID、密码分离、频道隔离、查询缓存降级、管理员修改/下架失效、管理权限、Session 必需、JSON/SSE 契约、TG 网络请求为零和混合流先返回本地结果。TG 测试会重建专用测试库的资源/频道 fixture；不会操作业务 Redis 或数据库。

## 16. 当前实现边界

- 公开网页可访问历史不是 Telegram 完整历史；不能保证私有、已删除、访问受限或公开页面不可翻页的内容。页面无法识别会报错，而不是虚报“全历史完成”。
- 首次自动全量历史补齐，无总页数限制，完成后不周期重抓；中断从持久游标继续。未出现消息不能证明上游已删除，不自动清库。
- 自定义频道只对本次提交频道实时 HTTP 搜索，不登记采集、不使用系统资源源或本地资源缓存。保存偏好与采集没有关联。
- 当前没有日期范围回填、全量快照重解析发布审批，也没有百万资源规模的性能验收。小样本功能测试不代表生产吞吐量。
- 增量追到上次检查点后结束；历史直到上游可访问边界后标记完成。规则变更只影响后续处理及失败页重新抓取。
- transform 只接受 Rust 原生 JSON DSL；新接口须在 src/app.rs 显式注册并补测试。完整设计及待扩展项见 docs/telegram-local-index-requirements.md。

## 管理后台界面

管理端使用 shadcn-vue / Reka UI，所有 `/admin/**` 页面共用一个布局和侧栏。后台组件、局部样式和权限门禁与首页搜索隔离；开发约定和验证方式见 [后台 UI 架构](docs/admin-ui.md)。

## TG 工作台与出站策略（2026-09-30）

| 入口 | 职责 |
| --- | --- |
| `/admin/proxies` | 只维护 HTTP 转发节点、启停、额度、熔断和只读引用；不再配置业务路由 |
| `/admin/sources` | 只维护实时 HTTP 来源；每个来源保存自己的出站策略 |
| `/admin/crawl` | 系统采集频道，行内任务/失败页、批量重试/忽略、暂停/继续、DSL 与出站策略 |
| `/admin/crawl` → 任务 | 按频道、状态、类型、创建时间查询；独立抽屉查看诊断、取消和重试 |
| `/admin/crawl` → 待复核 | 跨频道浏览解析失败/待复核消息；进入同一消息抽屉 |
| TG 采集 → 采集设置 | 全局并发频道数、每页等待、日常间隔；默认出站和通用 transform |

消息使用 Sheet，只展示消息元数据、解析错误和已存资源，不提供原文、摘要或规则预览。修改 DSL 不自动重写历史；失败页重试重新请求上游并使用当前规则。迁移 019 删除旧原文列；现有数据库的空间回收步骤见 [原文存储清理](docs/source-message-storage-cleanup.md)。

系统采集频道自动进入本地索引，暂停不隐藏已入库资源。用户自定义频道独立实时搜索。具体编排、数据库迁移和失败页语义见 [TG 新方案](docs/tg-channel-scheduling.md)。

### 出站和保存语义

- 直连 / 代理；TG 频道可继承默认。默认缺失时拒绝请求，不隐式直连。
- 按正权重加权随机选择，重试不重复节点；版本与节点成员同一快照读取。
- 直连是内置可选节点，勾选且权重大于 0 才参与；权重 0 不参与、不兜底。
- 每个来源/频道独占策略；被引用节点不能删除。节点引用入口只读。
- 节点额度全局共享，请求前原子预留；半开探测有过期租约。429 不轮换代理绕过限制。
- POST只发送一次。GET的可恢复失败继续下一节点，各次共用总超时预算。
- 频道、默认策略、默认解析模板使用版本检查，并发覆盖返回409。
- 任务 requestKey 防止响应丢失后重复创建；同一 key 不可提交不同参数。

### 升级与启动

1. `cargo run -- migration-preflight` 是只读预检，不执行 migrations。
2. 停止旧 API 和 worker，并使用 pg_dump 备份。不要让旧 worker 与新 schema 混用。
3. 新程序 `cargo run` 首次应用迁移并默认启动后台任务；前端在 frontend 运行 npm run dev。独立部署 Worker 时需显式关闭内嵌任务。
4. 核对原 source ID、数据数量、频道检查点、发布范围与策略成员。迁移成功后删除旧组和路由表，没有第二套策略入口。

006迁移旧组/路由并检查冲突；008再删除复杂策略字段，保留原代理权重，原本允许直连的配置转为勾选 direct（权重0），原纯直连转为仅选 direct。2026-10-01 执行语义改为加权随机，现有权重数值不变；权重0的旧直连配置不再兜底，如需直连参与须显式设置正权重。原 position 不再使用。009只重建派生标题索引，不删除资源、描述、消息或关联关系。

012 迁移移除旧用户频道采集登记、公共身份及弃用任务；历史预算结束的旧任务继续，已完成不重抓。管理员应在采集设置显式保存默认策略，否则新继承频道会显示待配置。

隔离集成测试配置专用 `PANSOU_TEST_DATABASE_URL`（库名以 _test 结尾）和 `PANSOU_TEST_REDIS_URL`，串行运行：

```powershell
cargo test
cargo test telegram_tests -- --ignored --nocapture --test-threads=1
cd frontend
npm run typecheck
npm test
npm run build
```

测试会改变测试库配置，禁止指向业务库；不要清空生产 Redis。实施说明见 docs/tg-workbench-implementation.md。

### 仅按名称匹配与慢 SQL 优化

本地资源搜索只匹配当前可见资源的 name，不用 description 或 tags 命中；描述/标签仍正常保存和展示。后台资源列表同样只按name筛选。缓存标识使用 name-only-v1，升级递增索引版本，旧描述匹配缓存不会复用。

频道统计和策略批量读取，消除逐频道N+1；新增覆盖/关系索引。TG资源和链接/gram只差量更新，不再由触发器和Rust重复全量重建。标题gram覆盖所有可用来源关系的名称，不把其他频道的标题泄露为当前频道展示。实测与验收见 [节点简化和SQL优化](docs/node-selection-and-sql-optimization.md)。

## 原生网盘工具（百度 / 夸克）

后台「网盘资源 → 网盘工具」支持分享检测、按文件去重转存、创建新分享，以及按自己的分享链接删除云端资源；每条链接旁也能进入工具。凭证在「系统 → 网盘账号」管理，仅 Rust 后端解密读取。删除必须预检并核对条目，写操作使用持久化 requestKey 幂等，响应丢失只查询，不自动重做。

完全使用 Rust / reqwest，不依赖 wangpan 分支的 Node 服务。010 只新增操作/确认记录表，不清空资源或 TG 索引。能力、接口和验收边界见 [原生网盘实现](docs/native-cloud-drive.md)。
