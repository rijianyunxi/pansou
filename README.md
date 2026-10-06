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

SQL 使用 SQLx 运行时查询，通过参数绑定和明确的 Rust 返回类型访问数据库。构建无需连接数据库或生成查询元数据；SQL 语法、数据库列类型与查询结果的匹配由运行时及数据库集成测试验证。

## 3. 项目目录

```text
pansou/
├─ Cargo.toml / Cargo.lock       # Rust 应用、依赖与编译配置
├─ .env.example                 # 后端配置模板；本机 .env 不提交
├─ docker-compose.yml           # PostgreSQL + Redis
├─ migrations/                  # 单份 044_schema.sql，直接创建当前结构
├─ docs/                        # 运行、部署、存储、SQL 和网盘设计说明
├─ scripts/                     # 部署辅助脚本
├─ .github/workflows/           # 多平台发布构建
├─ src/
│  ├─ main.rs                   # serve / worker / link-worker / auth-worker
│  ├─ app.rs                    # 共享状态、显式路由与 SPA 托管
│  ├─ db.rs / redis_store.rs    # 数据库、迁移和 Redis 连接
│  ├─ auth.rs / security.rs     # 会话、鉴权、限流和并发许可
│  ├─ policy.rs / runtime.rs    # 用户策略、后台开关、心跳和关闭信号
│  ├─ models.rs / error.rs      # 业务模型与统一错误
│  ├─ crawl.rs                  # TG 持久任务、租约、检查点与幂等入库
│  ├─ crawl/schedule.rs         # 六段 cron、北京时间和日常采集时段
│  ├─ telegram.rs              # TG 消息、频道身份和分页游标
│  ├─ transform.rs              # 原生 JSON DSL、JSON 解析与统一结果构造
│  ├─ transform/html.rs         # HTML / TG / PanSearch 解析
│  ├─ resource_clean.rs         # 字段清洗、分享身份、提取码和中文 grams
│  ├─ local_index.rs            # PostgreSQL 本地搜索与 Redis 缓存
│  ├─ search_cache.rs           # 实时搜索的内存缓存与容量控制
│  ├─ outbound.rs               # 出站策略、节点选择与额度预留
│  ├─ admin_stats.rs            # 管理统计、持久计数与缓存
│  ├─ cloud_drive/              # 五家网盘适配、请求传输与业务操作
│  ├─ cloud_auth/               # 扫码授权、凭证维护和续期
│  ├─ link_resolution.rs        # 链接目录、按需解析与操作状态
│  ├─ link_resolution/
│  │  ├─ projection.rs          # 搜索结果引用与会话授权复核
│  │  ├─ status.rs              # 链接与资源有效性查询
│  │  ├─ delivery.rs            # 转存、自产分享复用与网盘配置
│  │  ├─ management.rs          # 清理任务管理
│  │  └─ worker.rs              # 同步、检测、到期清理和恢复
│  ├─ handlers.rs               # handler 声明与导出
│  ├─ handlers/
│  │  ├─ common.rs              # 响应与权限辅助
│  │  ├─ admin_paging.rs        # 管理列表分页辅助
│  │  ├─ public.rs              # health、热搜、robots 和 sitemap
│  │  ├─ account.rs             # 登录、个人资料、微信与频道偏好
│  │  ├─ settings.rs            # 来源、解析规则和用户策略设置
│  │  ├─ admin.rs               # 资源、代理、日志和用户管理
│  │  ├─ crawling.rs            # TG 频道、任务、cron 校验预览与采集配置
│  │  ├─ monitoring.rs          # 运行监控与后台开关
│  │  ├─ tasks.rs               # 任务工作台与检测重试
│  │  ├─ cloud_drive.rs         # 管理员网盘操作接口
│  │  ├─ cloud_accounts.rs      # 网盘账号授权管理接口
│  │  ├─ search.rs              # JSON / SSE 搜索接口与结果交付
│  │  └─ search/
│  │     ├─ sources.rs          # 系统来源与个人实时频道加载
│  │     ├─ execution.rs        # HTTP 请求、代理重试和阶段观测
│  │     ├─ health.rs           # 原子快照更新、分位数与熔断读取
│  │     ├─ orchestration.rs    # 本地优先、实时来源并发与聚合
│  │     ├─ cache.rs            # 实时搜索缓存键与容量策略
│  │     └─ logging.rs          # 搜索日志与热搜计数
│  ├─ queries/ / sql/           # 固定查询与共享 SQL
│  └─ *_tests.rs / **/tests.rs  # 单元测试与显式启用的隔离集成测试
├─ frontend/
│  ├─ package.json / vite.config.ts
│  ├─ src/                     # Vue 启动、路由和 API 运行时
│  ├─ pages/                   # 搜索、个人设置与管理页面
│  ├─ components/              # 首页、后台、监控与来源配置组件
│  ├─ composables/             # 会话、搜索和偏好状态
│  ├─ shared/ / types/         # 公共契约与页面类型
│  ├─ utils/                   # SSE、结果合并与展示辅助
│  ├─ assets/ / public/        # 样式和静态资源
│  └─ tests/                   # 前端验证脚本
├─ miniprogram/                # 微信小程序客户端
├─ logs/                       # 本地日志（生成目录）
└─ target/                     # Rust 编译产物（生成目录）
```

`target/`、`frontend/node_modules/`、`frontend/dist/` 都是生成目录，不属于业务源码。

### 数据库迁移

当前以 **044_schema.sql** 为结构基线，另有 **046_remove_unused_settings.sql** 清理升级，直接创建最终使用的表、约束、索引、函数、触发器和内置默认配置。新库自动执行，后续变更新增 047 及之后的版本。

历史 001–043 已合并，不再创建旧表后删除，也不再重放历史数据变换。已有库需要先升级到旧最终结构、备份并完成一次性 SQLx 基线记录切换；本地库已完成。详细说明见 [migrations/README.md](migrations/README.md)。

## 4. Rust 服务启动流程

`cargo run` 后，`src/main.rs` 按以下顺序启动：

1. 读取 `.env`，初始化日志和数据库连接池。
2. 读取运行模式：serve、worker、link-worker 或 auth-worker。
3. 启动通过 `sqlx::migrate!("./migrations")` 执行未应用迁移，初始化管理员，再连接 Redis。
4. 创建共享 `AppState`，复用数据库连接池、Redis、HTTP 客户端、缓存与并发控制器。
5. `worker` 运行 TG 采集；`link-worker` 运行链接后台任务和账号凭证维护。两者都不监听 HTTP。
6. `serve` 构造 API 和 SPA 路由，默认监听 `0.0.0.0:3666`，并运行账号凭证维护。
7. `serve` 默认内嵌 TG 与链接 worker；设置 `PANSOU_EMBEDDED_WORKERS=false` 后可独立部署这两类 worker。
8. 收到关闭信号时取消共享运行状态，停止领取新任务并等待后台任务退出。

服务启动时 PostgreSQL 或 Redis 不可用会直接启动失败，不会带着残缺依赖继续运行。

## 5. 后端模块关系

```mermaid
flowchart TD
    MAIN[main.rs] --> APP[app.rs / AppState]
    MAIN --> DB[db.rs / migrations]
    MAIN --> REDIS[redis_store.rs]
    MAIN --> CRAWL[crawl.rs / cron]
    MAIN --> LINKS[link_resolution / worker]
    MAIN --> CLOUD_AUTH[cloud_auth / 凭证维护]
    APP --> HANDLERS[handlers / HTTP 接口]
    HANDLERS --> SEARCH[search / 编排与来源执行]
    HANDLERS --> ADMIN_STATS[admin_stats / 管理统计]
    HANDLERS --> SECURITY[auth / security / policy]
    SEARCH --> LOCAL[local_index / 本地查询]
    SEARCH --> CACHE[search_cache / 实时缓存]
    SEARCH --> TRANSFORM[transform / resource_clean]
    SEARCH --> OUTBOUND[outbound / 出站请求]
    CRAWL --> TRANSFORM
    CRAWL --> OUTBOUND
    SEARCH --> LINKS
    LINKS --> CLOUD[cloud_drive / 网盘适配]
    CLOUD_AUTH --> CLOUD
    HANDLERS --> RUNTIME[runtime / 心跳与开关]
    LOCAL --> PG[(PostgreSQL)]
    CRAWL --> PG
    LINKS --> PG
    SECURITY --> PG
    APP --> REDISDB[(Redis)]
```

### `AppState`

每个请求共享同一个 `Arc<AppState>`：

```text
AppState
├─ PgPool / RedisStore                 数据库连接与临时状态
├─ http / crawl_http / cloud_http      各业务复用的 HTTP 客户端
├─ search_cache / admin_stats          有容量或有效期限制的共享缓存
├─ local_search_slots / locks          本地查询并发预算与相同查询合并
├─ cloud_slots / custom_link_refs      网盘并发与个人实时频道引用
└─ security / shutdown / started_at    安全配置、关闭信号与服务起始时间
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
| `source_health` | 来源成功率、耗时、失败次数、最近执行结果 |
| `proxy_nodes` | 代理节点、额度、熔断和最近状态 |
| `outbound_policies` | 实时来源 / TG 频道各自的节点配置和版本 |
| `outbound_policy_nodes` | 节点勾选和随机分配权重；节点删除受引用保护 |
| `users` | 用户、管理员、角色、状态、自定义频道 |
| `auth_identities` | 微信等外部身份与本地用户的绑定 |
| `search_logs` | 搜索关键词、范围、来源、结果数、状态和时间 |
| `hot_searches` | 热搜词、分数、审核状态和置顶状态 |
| `managed_resources` | 人工与 TG 采集资源的名称、描述、图片和来源 |
| `resource_links` | 每条资源的链接、网盘类型、提取码、顺序与检测状态 |
| `policy_settings` | 用户策略、搜索参数、后台开关、微信小程序配置及搜索配置更新时间 |
| `cloud_account_settings` | 云盘账号凭证、绑定版本与登录状态 |
| `cloud_provider_policies` | 每个网盘一行的按需转存开关/目录/清理时间与有效性检测参数 |

数据库基线启用 `pg_trgm`，并为日志关键词、资源搜索、热搜、代理路由、用户列表等查询建立 B-tree、GIN 和部分索引。

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
4. 按登录/匿名策略原子消费 Redis 中的 Session、IP 和网段搜索额度；任一额度超限返回 HTTP `429` 和 `SEARCH_LIMIT_EXCEEDED`。
5. 获取 Session 级和全站搜索并发许可；Session 并发超限返回 HTTP `429` 和 `SEARCH_LIMIT_EXCEEDED`，全站并发超限返回 HTTP `503` 和 `SERVER_BUSY`。
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

用户自定义频道搜索使用内置 TG 解析规则和规范公开频道 URL，实时请求频道页面；不登记采集任务，也不依赖系统频道解析配置。每个频道生成一个临时实时来源：

```text
custom:{channel_name}
```

### 7.5 并发执行来源

后端通过：

```rust
buffer_unordered(concurrency)
```

并发执行多个来源。默认并发数由 `user-policy.defaultConcurrency` 决定（默认 `4`），单次执行最大 `32`。

来源先划分为 TG 本地查询和非 TG 实时查询。TG 一次批量查 PostgreSQL/Redis，先返回本地结果，再启动并发的实时来源请求并按完成顺序推送。非 TG 单源失败不阻断其他来源；本地数据库故障返回明确错误，不悄悄回退联网。

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
实时来源 / TG 频道独立配置
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
- 累计平均响应时间，以及最近最多 100 次请求耗时的真实 p50 / p95（nearest-rank 算法）；
- 最近执行结果；
- 最近错误信息。

同一来源的快照在数据库事务中先确保记录存在，再 `SELECT ... FOR UPDATE`，最后更新提交；支持首次并发写入及多进程部署。读取或锁定失败只记录日志，不以空快照覆盖已有数据。统计写入设置锁等待和语句超时，避免阻塞搜索。

每次完整来源执行计为一个请求，代理重试不增加请求数。维度描述最后一次实际请求：网络为请求与响应读取，HTTP 为成功状态码，解析为 DSL 执行，结果为成功解析后是否有结果。未执行的阶段不计入该维度分母；目前没有独立业务成功断言，`business` 保持未知，`passRate=null`。旧快照中的伪分位数和伪维度通过率在监控接口中显示为未知；维度计数在首次新请求时重建，已有总请求数保留。`responseTimeWindow` 标明分位数窗口与样本数，历史桶只保留当前及此前 23 个钟点。

后台运行监控页面通过管理员接口 `/api/monitor` 展示 API / PostgreSQL / Redis 状态、TG 与链接服务心跳、任务队列、最近 24 小时点击交付结果和实时来源统计。TG 搜索身份不再混入实时来源健康统计。TG 调度与到期清理可以分别暂停，开关存入 PostgreSQL `policy_settings.background-workers`，默认启用；暂停在当前批次完成后生效，重启保留。兼容旧字段 `linkEnabled`，但其含义现仅为到期清理应急开关（接口 `/api/admin/runtime/workers/cleanup`）；资源链接同步、状态汇总与按需取链不受该清理独立开关影响。链接任务总调度开关 `linkScheduleEnabled` 则同时控制资源链接同步、定期检测、到期清理和过期与超时处理；暂停后项目、搜索和用户复制/打开仍可运行，按需转存仍按网盘配置执行，后台清理会延后。旧的显式暂停不会被自动恢复。

「系统 → 网盘账号」集中管理五家网盘的扫码连接、凭证维护、按需转存与有效性检测，系统设置只保留跳转入口。阿里、光鸭令牌支持自动续期，百度、夸克维护 Cookie 并定期检查；迅雷暂用高级导入。账号凭证保存在 PostgreSQL 中，不再依赖本地加密密钥；数据库及其备份包含可直接使用的凭证，应限制访问。详见 [网盘账号管理](docs/cloud-accounts.md)。页面不再分页签：每家网盘是一张卡片，上半部分管理授权，下半部分展示转存与检测状态；卡片上的「转存」按钮打开配置弹窗，设置按需转存开关、项目专用目录（不能选根目录）、清理时间、平台分享期限，以及检测间隔、每日额度与缓存参数，弹窗的「转存」保存生效、「清除」关闭并清空转存配置。每个网盘的配置存在 `cloud_provider_policies` 一行里（迁移 026 从原 `link-delivery` / `link-check` JSON 搬运并删除旧键），`link-check` 只保留后台检测总开关。转存仅在用户复制/打开时发生，没有定时批量转存；关闭转存不取消既有产物的清理，也不禁止复用仍可用的自产分享。后台巡检独立控制，关闭只停止批量检测，保存检测参数不会改变启停状态。

入库只解析并记录链接，通过本地 outbox 异步关联与排队检测，不阻塞采集。`validity=1` 表示明确有效，`0` 仅表示原分享明确失效/资源不存在，`-1` 表示未知：网络、登录、限频、密码或接口错误均覆盖当前有效性为 `-1`，不会沿用旧的 `0/1`。后台巡检跳过未配置凭据或仍在检测缓存/退避期的链接，优先新入库与最近被点击的链接；每网盘每日原链检测预算至少保留 20% 给点击请求。

点击时先检查原始分享身份及提取码指纹、当前凭据指纹和目标目录对应的自产映射，不按标题猜测已有文件。可用自产分享优先返回，原分享失效不会覆盖它；不存在可用产物时，核验原分享后才创建独立子目录、转存与分享。除明确原分享失效/资源不存在之外，其他失败返回原链接及提取码。复用不延长保留期，配置修订也不重置已有产物的保留时间。到期仅撤销记录在案的自产分享并清理归属与完整文件树均核实的流程子目录；内容被人工修改或写入状态不确定时阻塞清理，不盲目删除。

### 7.10 后端聚合和去重

所有来源完成后，后端保留本地优先的结果顺序，按来源 `priority` 排序统计信息，并记录未做跨来源去重的总结果数。采集入库时处理本地资源去重；跨来源展示去重由前端完成。

链接交付层按规范分享身份生成会话绑定的 `dedupKey`，没有链接时使用来源与结果 ID。前端按键合并卡片，同时保留完整的引用及链接授权快照，避免混用不同结果的授权信息。

随后更新 `search_logs` 的完成状态、结果数、是否有结果、各来源结果数、实际来源 ID 和完成时间。

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

资源不再解析、存储或返回 `tags`；上游标签不进入统一资源模型。

### 7.12 前端消费、合并和展示

`frontend/composables/useSearch.ts`：

1. 使用 `fetch()` 请求 `/api/search`。
2. `searchEventStream.ts` 从 `ReadableStream` 解析 SSE block。
3. 收到 `start` 保存 `searchLogId`。
4. 收到 `result` 把新结果合并到现有状态。
5. 收到 `complete` 标记搜索完成。
6. 处理 `401`、`403`、`429`、`503` 和普通错误；`SESSION_REQUIRED` 会触发一次 Session 重建，`SEARCH_LIMIT_EXCEEDED` 不会被误判成登录失效。
7. 使用 `AbortController` 支持取消、暂停和离开页面时中断请求。

前端增量合并不是按来源 ID，也不是按结果 ID，而是按**分享链接 URL**：

```text
同一个分享 URL -> 同一个资源组
```

合并时：

- URL 去掉 hash；
- hostname 转小写；
- 处理末尾 `/`；
- 合并密码、云盘类型和 images；
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
| `/api/account/wechat/session` | 小程序专用会话：POST 用微信 code 建号/登录，GET 用 Bearer 读取用户和页面配置 |
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

POST /api/account/wechat/session
  -> {code}：服务端换取 openid，返回业务 token、expiresAt、user 和页面配置
  -> {anonymous:true}：显式申请匿名 token，返回到期时间和页面配置
  -> 不设置 Cookie；不接受客户端提交的 openid/session_key

GET /api/account/wechat/session
  -> 必须携带有效 Bearer：返回当前用户和页面配置，不创建或续期 Session
  -> 缺少或失效 Bearer：401

POST /api/search
  -> 无有效 Session：401 SESSION_REQUIRED
  -> Session/IP/网段搜索额度超限：429 SEARCH_LIMIT_EXCEEDED
  -> Session 并发超限：429 SEARCH_LIMIT_EXCEEDED
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

后台频道资源数从主表的来源频道数组统计，任务数量从采集任务表统计，共享 30 秒缓存。资源停用或删除后从可用资源统计中排除。监控资源总数及链接目录统计也使用 30 秒缓存；心跳、任务队列及后台开关实时查询。

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

日常更新：下载新的 `pansou-linux-amd64.tar.gz`，`tar xzf pansou-linux-amd64.tar.gz -C /opt/pansou` 覆盖二进制与静态文件，然后 `sudo systemctl restart pansou`。数据库迁移在启动时自动执行（`sqlx::migrate!` 嵌于二进制内）；降级前需检查迁移兼容性；发生不兼容的结构或数据变更时，应恢复匹配版本的数据库备份，再运行旧程序。

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

### 日常 cron 与空闲等待

采集设置支持六段 cron（`秒 分 时 日 月 周`），固定使用北京时间，服务器所在时区不会改变执行时间。无需额外时间窗口：

- `0 */10 * * * *`：全天每 10 分钟执行一次。
- `0 */10 8-21 * * *`：每天 08:00–21:50 每 10 分钟执行一次，22:00 起停止领取日常增量页。
- `0 */10 8-21 * * MON-FRI`：工作日白天每 10 分钟执行一次。

秒、分钟字段决定增量任务触发点；小时、日期字段限制日常任务后续分页，页间继续使用“每页等待时间”。超出允许时段时，已执行的页完成提交，剩余增量进度保留至下一次 cron。首次最新页及历史全量回填不受日常计划限制；失败页的手动重试也是独立任务。任务尚未完成时不会按每个 cron 点重复创建，重启后最多继续一个到期任务，不补建错过的所有触发点。下次执行时间为增量完成后的下个 cron 匹配时刻。

空闲 worker 使用 PostgreSQL `LISTEN/NOTIFY`、最近到期时间和本进程页面完成通知等待；每 60 秒做一次兜底检查，不再每秒按并发槽位创建空任务。配置保存、频道启停、新任务及租约变化在事务提交后唤醒所有独立 worker。通知连接临时失效时仍按到期时间/兜底检查恢复，数据库任务和租约始终是执行依据。

界面手动输入六段 cron，停止输入后自动调用只读预览接口 `/api/admin/crawl/settings/preview`，用与 Worker 相同的解析器校验并计算未来 5 次北京时间；下方展示中文计划含义。预览不修改配置、不创建任务；只有当前输入校验通过后才能保存。

迁移 `033` 新增任务通知触发器；`034` 将已有五段 cron 一次性补充秒字段，未配置者设置为 `0 */10 * * * *`，删除旧间隔列。接口和运行时只接受六段 cron，缺失、null、五段及旧间隔参数均拒绝。升级需停止旧 API / worker，运行新版本应用迁移，再启动独立 worker。

### 采集流程

1. 管理员在 TG 工作台直接维护频道；公共来源身份绑定保留原 source ID。用户保存自定义频道时幂等登记采集意向，不再通过来源列表或定时全表发现同步配置。
2. worker 优先采最新页，随后连续补齐首次历史，无总页数限制。日常增量支持六段 cron（北京时间）；推荐每 10 分钟一次。
3. 直接读取公开页的 data-post 消息身份和 tme_messages_more 游标，不假定消息 ID 连续，也不携带用户搜索关键词抓取。
4. worker 使用频道唯一出站策略与统一调度服务；每个采集频道独立选择节点和权重，缺失则阻止网络采集，不能借其他频道策略。任务记录实际节点、耗时及版本。403/404明确失败；429按Retry-After退避，不换代理绕过限制。
5. 原始消息 HTML 仅用于当次解析；消息任务仅在 crawl_message_tasks 保存消息编号、任务时间、状态、失败原因和 resource_ids 数组。每频道仅保留上海时区当天处理的成功记录（已解析、无资源），未处理失败不限条数；重试成功按处理当天保留，跨天自动清理；手动忽略直接删除任务记录，不计入成功数量。资源主表保存来源频道数组和代表消息编号，删除任务记录不影响历史资源搜索、取链或资源数量。同一 Rust transform DSL 提取并清洗标题、简介、网盘链接、密码和时间；不执行 JavaScript。多段明确标题分开解析；高歧义大量链接聚合帖隔离为待复核。
6. 按规范分享集合入库 managed_resources，标题、简介、链接、图片只保存一份；不同链接集合独立保存，不按标题合并。来源频道保存在 source_channel_ids 数组中。搜索直接读取主表，生成列 name_grams 配合 GIN 索引支持中文单字/双字候选检索。重复内容跳过更新，较老回填不覆盖新内容；较新采集可覆盖手动编辑，停用状态保持不变；删除资源直接 DELETE，后续采集可重新入库。
7. 页面资源、关系、解析状态、任务进度、数据库缓存版本在同一事务提交。重复页面不重复造资源；编辑时尽量保留资源 ID；管理员 override 不被后续采集覆盖。
8. 首次自动全量历史采集，无总页数限制，完成后不周期重抓；历史与日常增量游标独立，到期增量穿插执行。全局并发频道数、每页等待、日常六段 cron可配置；同频道仅一个执行页，租约过期恢复。

### 搜索流程与契约

Session/权限/限流/并发校验 → 服务端计算可见来源 → TG 一次批量本地查询 → Redis 未命中则查 PostgreSQL → 与非 TG 实时来源结果流合并 → 原契约 SSE → Vue 展示。

- 系统 TG 搜索不访问 t.me，未命中不回退联网。用户自定义频道搜索与采集完全独立，仅对本次提交频道实时 HTTP 搜索并使用通用 transform，不查询资源库/结果缓存。
- Redis 正结果 60 秒、空结果 10 秒；key 包含关键词、授权来源集合和 PostgreSQL 索引版本。版本与数据同事务更新，管理员修改/下架立即失效。
- 仅按标题匹配，标题精确命中优先，其余按消息发布时间降序；本地返回上限 200，SQL 5 秒超时。total 是 API 本次返回的记录数，包含跨来源重复结果，不是全库计数。
- 共享资源从本次允许频道的 occurrence 取展示文本，不泄漏其他个人频道的标题/简介。
- 仅查询缓存失败可回源 PostgreSQL；Redis 会话/安全校验失败仍拒绝请求，不匿名放行。
- /api/search 仍为 start/result/complete/error。纯本地查询通常快速返回；混合查询本地结果不等慢来源。
- /api/search/json 仍仅管理员，返回 total/results/sources/searchLogId；results 为本地优先的扁平资源数组，sources 仅保留外部实时来源统计，TG 不再返回来源 priority 或执行统计。历史采集代理记录只在采集管理展示。
- 采集入库和前端展示只合并完全相同的分享集合，避免合集“桥接”误合并单资源。移动云盘不同 hash 是不同分享。API 仍是一资源多个 links，前端仍拆链接卡片。
- 人工创建的旧资源不自动公开到 TG 搜索；TG 资源删除是软下架，保留采集溯源，避免下次爬取又恢复。

### 后台管理

访问 /admin/crawl，在频道行内查看任务和失败页、勾选批量重抓/忽略，设置全局调度参数、暂停/继续采集，查看今日采集资源数量和消息任务的时间、状态及摘要；点击资源名称打开与网盘资源页面共用的资源详情抽屉。采集原文只在解析过程中临时使用，不长期保存；独立消息详情、原文和规则预览已删除。接口全部为显式 Axum 路由并要求管理员权限。

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
- transform 只接受 Rust 原生 JSON DSL；新接口须在 src/app.rs 显式注册并补测试。当前采集与搜索行为见本文第 15 节。

## 管理后台界面

管理端使用 shadcn-vue / Reka UI，所有 `/admin/**` 页面共用一个布局和侧栏。后台组件、局部样式和权限门禁与首页搜索隔离。

## TG 工作台与出站策略（2026-09-30）

| 入口 | 职责 |
| --- | --- |
| `/admin/proxies` | 只维护 HTTP 转发节点、启停、额度、熔断和只读引用；不再配置业务路由 |
| `/admin/sources` | 只维护实时 HTTP 来源；每个来源保存自己的出站策略 |
| `/admin/crawl` | 系统采集频道，行内任务/失败页、批量重试/忽略、暂停/继续、DSL 与出站策略 |
| `/admin/crawl` → 任务 | 按频道、状态、类型、创建时间查询；独立抽屉查看诊断、取消和重试 |
| `/admin/crawl` → 失败任务 | 顶部统计全部频道未处理失败消息总数；点击频道失败任务数进入消息抽屉 |
| TG 采集 → 采集设置 | 全局并发频道数、每页等待、日常六段 cron |

采集记录使用 Sheet，以“全部 / 成功 / 失败”直接切换，展示消息编号、任务时间、状态和摘要；成功摘要为当前资源名称，失败摘要为失败原因。资源名称打开共享资源详情抽屉。修改 DSL 不自动重写历史；失败任务重试重新请求上游并使用当前规则。迁移 040 重建任务记录表，删除旧消息表、原文 hash、解析版本、消息发布时间及最后查看时间；资源来源仍独立保存实际发布时间。

系统采集频道自动进入本地索引，暂停不隐藏已入库资源。用户自定义频道独立实时搜索。采集编排、cron 与失败页语义见本文第 15 节。

### 出站和保存语义

- 直连 / 代理；每个 TG 频道独立配置，未配置节点时拒绝请求。
- 按正权重加权随机选择，重试不重复节点；版本与节点成员同一快照读取。
- 直连是内置可选节点，勾选且权重大于 0 才参与；权重 0 不参与、不兜底。
- 每个来源/频道独占策略；被引用节点不能删除。节点引用入口只读。
- 节点额度全局共享，请求前原子预留；半开探测有过期租约。429 不轮换代理绕过限制。
- POST只发送一次。GET的可恢复失败继续下一节点，各次共用总超时预算。
- 频道和节点策略使用版本检查，并发覆盖返回409。频道解析规则留空使用内置 TG 解析规则。
- 任务 requestKey 防止响应丢失后重复创建；同一 key 不可提交不同参数。

### 升级与启动

新库直接启动程序，由 044 初始化当前结构。旧库切换前停止 API 和 worker，完整备份并按照迁移目录说明验证结构及切换基线记录；完成后运行新程序。前端在 frontend 运行 npm run dev；独立部署 Worker 时显式关闭内嵌任务。

隔离集成测试配置专用 `PANSOU_TEST_DATABASE_URL`（库名以 _test 结尾）和 `PANSOU_TEST_REDIS_URL`，串行运行：

```powershell
cargo test
cargo test telegram_tests -- --ignored --nocapture --test-threads=1
cd frontend
npm run typecheck
npm test
npm run build
```

测试会改变测试库配置，禁止指向业务库；不要清空生产 Redis。

### 仅按名称匹配与慢 SQL 优化

本地资源搜索只匹配当前可见资源的 name，不用 description 命中；描述仍正常保存和展示，资源标签已移除。后台资源列表同样只按name筛选。缓存标识使用 name-only-v1，升级递增索引版本，旧描述匹配缓存不会复用。

频道统计和策略批量读取，消除逐频道N+1；新增覆盖/关系索引。TG资源和链接/gram只差量更新，不再由触发器和Rust重复全量重建。标题gram覆盖所有可用来源关系的名称，不把其他频道的标题泄露为当前频道展示。

## 原生网盘工具（百度 / 夸克）

后台「网盘资源 → 网盘工具」支持分享检测、按文件去重转存、创建新分享，以及按自己的分享链接删除云端资源；每条链接旁也能进入工具。凭证在「系统 → 网盘账号」管理，仅 Rust 后端解密读取。删除必须预检并核对条目，写操作使用持久化 requestKey 幂等，响应丢失只查询，不自动重做。

完全使用 Rust / reqwest，不依赖 wangpan 分支的 Node 服务。010 只新增操作/确认记录表，不清空资源或 TG 索引。能力、接口和验收边界见 [网盘交付与清理管理](docs/cloud-drive-providers.md)。

### 后台任务容量与关停（035）

当前结构包含派生有效性刷新队列、跨实例调度时间槽和 lane 累计指标。升级应停止旧 API/worker，启动新版本执行迁移，再恢复服务；旧版本的 provider 独占锁与新版本共享锁不可作为长期混合部署方案。

- 点击取链在数据库短事务内执行原子准入：集群最多 32 个未到期请求、每 subject 最多 4 个；每进程最多登记 16 个取链任务，另保留 30 次/分钟的 subject 限频。容量不足返回 429。
- 取链任务进入进程任务集合。收到关闭信号后停止准入，已开始的云盘操作继续保存回执，最多等待 150 秒；HTTP 优雅关闭窗口为 30 秒，后台 worker 也有 150 秒上限；三个等待阶段并行执行。部署管理器应提供至少 180 秒的正常关停宽限。
- 同一 provider 最多同时执行 4 个 delivery/cleanup 写工作流（数据库锁跨实例生效）；同一账号、同一链接仍串行。账号变更、管理员任意文件写操作及交付策略变更使用 provider 独占锁，与所有交付/清理互斥。进程内先排队，跨实例锁竞争采用指数退避和抖动。
- 同步、检测与过期更新不再获取采集的全局索引锁。链接观察与聚合刷新任务在同一数据库事务提交；资源繁忙时，列表中的派生有效性允许短暂延迟，后续 sync lane 会继续刷新。状态接口直接批量读取链接事实。暂停 sync lane 会延迟这类派生汇总。
- sync/cleanup 有积压时继续处理，空闲时等待；check 按 provider 并发处理，继续遵守 Redis 全局间隔、熔断和每日预算。入队扫描跨实例每 30 秒领取一次，仍采用索引游标分页。采集 schedule/recover 扫描跨实例每秒最多领取一次，实际任务领取仍保留数据库全局容量保护。maintenance 每次最多追赶 20 批，再交还执行机会。
- lane 的 tick panic 被隔离并记录，数据库/Redis 故障会指数退避。配置有进程内短 TTL 缓存及 PostgreSQL 通知失效；通知不是执行依据，丢失通知由 TTL 补偿。
- `/api/monitor` 的 `workers.links.lanes` 提供各 lane 心跳、累计处理次数/执行次数/失败次数、最近执行时长和成功/错误时间；`links.aggregatePending` 提供派生汇总积压。累计 processed 表示处理尝试，不等同于外部操作成功量，可由相邻采样计算处理速率。
- custom 搜索引用使用带 TTL 的 Redis 能力快照，后续请求可落到任意 API 实例。不会写入资源目录，但生成和读取引用需要 Redis 可用。
- 采集页面先解析，再逐消息短事务落库，最后推进页面游标。中途崩溃会重放未完成页面，依靠消息幂等性避免丢失；已提交的部分消息可先被搜索到。

新增 `pansou-api auth-worker` 可单独运行凭证维护。`PANSOU_AUTH_WORKER_ENABLED=true/false` 可显式控制任意模式的凭证维护；默认兼容原行为：serve/link-worker 开启，worker 关闭。独立 auth-worker 必须开启。需要恰好一个凭证维护进程时，在 serve/link-worker 设置 false，仅启动一个 auth-worker；数据库 refresh lease 继续保护意外重复部署。

不可确认的外部写不会因恢复而盲目重放。resolve 到期后批量完成为原链接或不可用结果，并提前调度该请求独占且未曾交付的产物清理；损坏的授权快照也会安全完成，避免堵住恢复分页。产物仍交由持久清理任务核实；无法证明归属时保留人工核实状态。check、cleanup、crawl 继续使用各自的租约，保持其不同的重试和副作用语义。

后端 CI 使用隔离 PostgreSQL 与 Redis DB 15，执行 `cargo test --locked -- --include-ignored --test-threads=1`，包含原来默认忽略的数据库锁、租约、清理和采集回归。


### 链接 worker 调度补充（036）

- 五个 provider 使用独立检测循环与失败退避，检测 enqueue/recover 另行调度；某一家慢请求不再阻塞其他 provider 的下一轮。Redis 仍执行跨实例检测间隔、每日预算及熔断限制。
- 检测总开关与可用账号列表共享 5 秒缓存；后台开关和账号可用性/绑定变化通知会提前失效缓存，通知断开时由 TTL 兜底。当前结构包含账号变化通知，不对同一绑定的每次令牌/Cookie 续期发送通知。
- 后台检测只提交链接事实与派生刷新 outbox，sync 与 maintenance 都可消费派生队列。交互式检测仍尝试立即刷新；暂停两个消费者时，派生有效性延后到恢复后更新。
- `workers.links.lanes` 中新增 `link-check:{provider}` 和 `link-check-enqueue` 指标。provider 的 `processed` 统计获得明确 valid/invalid 结果的检测；未知结果记为失败，跳过或基础设施故障不计成功。基础设施故障重新排队，并保留此前链接有效性。
- 每个实例最多并行执行 4 个 cleanup 任务，不预领等待中的 backlog。每个任务独立捕获 panic，批次等待其他已领取任务完成；仍遵循 180 秒租约、120 秒尝试上限和原有跨实例云盘写锁。
- 清理暂时失败采用从约 60 秒开始、最高 30 分钟基础间隔的指数退避，加最多 20% 抖动；累计 12 次后转为 blocked。写锁忙约 10 秒重试且不消耗失败次数；账号授权、归属核实与明确凭证/权限错误立即暂停，等待修复后重试。


### 网盘凭证存储

网盘账号凭证以明文保存在 PostgreSQL，不再生成或读取本地密钥文件。旧版加密凭证升级工作已完成，不会在初始化基线时重复清理已有凭证。扫码过程中间状态也会取消并清除，需重新扫码。

TG 资源内容统一保存在 `managed_resources`，来源频道和任务资源 ID 直接存在数组中，不再有出现记录、搜索投影、拆字明细及派生统计表。所有频道统一展示主表内容；旧消息中不同标题不再作为搜索别名，消息链接改变会生成独立资源而非追踪旧消息版本。链接绑定不再区分消息来源。升级需要停止旧进程，备份并应用迁移后启动新版本；不支持旧程序混用新结构。

新增的忽略任务删除规则已折入 044 基线：`crawl_message_tasks` 只允许 parsed、empty、failed；忽略失败任务直接删除记录，不影响资源。后续编号从 046 开始，避免与本轮折入的临时 045 混淆。

通用配置统一保存在 policy_settings，采集调度和网盘策略保留独立结构；system_settings、search_settings、search_setting_sources、cloud_account_aliases 已在 046 删除。047 将微信配置完整迁入 policy_settings 的 wechat-mini 并删除原表；策略只更新发生变化的字段，并在事务中串行合并部分更新。搜索配置版本更新时间保存到 policy_settings 的 search-settings-meta。后台链接检测关闭时清理可重建的排队任务，保留手动请求与运行中任务；启用后通过目录扫描重新补齐。

048 将链接内容和检测事实统一保存到 resource_links，一条链接直接属于一条资源。managed_resources 不再保存 links_json 或 links_revision，删除 link_catalog、resource_link_bindings、link_sync_queue 及异步同步通道。资源和链接在同一个事务入库，搜索先筛选资源再加载链接。实时来源及仍需清理云端产物的链接允许暂时没有资源归属；没有任务/产物引用的临时链接由维护任务回收。升级前必须停止所有旧版写入进程并备份；使用应用迁移器生成分页规范化输入再执行 048，不支持直接执行单个升级 SQL。

049 删除链接表两张冗余索引，保留资源顺序、网盘筛选、检测调度、临时链接及 UUID 主键索引。

TG 采集顶部的“失败任务”与频道列表统一统计 `crawl_message_tasks` 中 `status=failed` 的消息记录，包含暂停频道，不随列表筛选改变。失败计数实时查询，忽略或重试成功后刷新即可同步；资源数量仍使用 30 秒缓存。失败页检查点 `crawl_page_failures` 按页统计，供采集恢复使用，不作为消息失败总数。050 为未处理失败消息增加局部索引，避免实时计数扫描成功任务。

频道列表“今日成功任务”统计北京时间当天 `parsed` 和 `empty` 的消息记录数，与今日采集抽屉“成功”页签及分页总数一致，点击直接进入该页签。任务计数实时查询，不按资源去重、不受资源停用或删除影响；一条消息可有多个资源，多条消息也可引用同一资源，因此资源数与成功任务数分别计量。API 的 `todayResourceCount` 继续表示今日任务关联的去重可用资源数，`todaySuccessCount` 表示今日成功消息任务数。

搜索频率及会话并发超限统一返回 HTTP 429、`SEARCH_LIMIT_EXCEEDED` 和 `Retry-After`，JSON 的 `statusCode` 为 429，`retryAfter` 与响应头秒数一致。频率超限按当前固定时间窗口的剩余秒数计算，不用从首次请求起算的 Redis TTL；会话并发超限建议 1 秒后重试。无效会话继续返回 401，会话限流不会触发前端会话重建；全站并发容量不足继续返回 503。429 响应禁止缓存，客户端不自动重试搜索。
