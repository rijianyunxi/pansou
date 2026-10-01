> 2026-10-01：本文保留历史背景；当前 TG 编排与自定义搜索以 [新方案](tg-channel-scheduling.md) 为准。公共搜索身份、用户频道采集登记、页数预算、复查/重解析/归档均已移除。

# TG 工作台与出站策略：实施与验收记录

> 后续变更：节点配置已简化为选择+优先权重，直连是可选节点；搜索改为仅名称。本文原复杂策略语义是上一版验收记录，当前行为与最新性能见 [节点简化和SQL优化](node-selection-and-sql-optimization.md)。

- 日期：2026-09-30
- 状态：本轮核心功能已实施，已在本机完成数据库迁移并启动新 API / worker。
- 范围：后台管理、TG 采集及共享出站执行层。首页搜索 UI 不在修改范围。
- 技术：Vue 3 SPA、shadcn-vue / Reka UI、Rust / Axum、PostgreSQL、Redis。当前数据库不是 MySQL。

## 1. 页面与配置归属

| 页面 | 实际职责 |
| --- | --- |
| /admin/proxies | HTTP 转发节点、启停、全局额度、熔断、只读引用；没有策略组或路由规则编辑入口 |
| /admin/sources | 实时 HTTP 来源的请求、Rust transform DSL、启用状态与独立出站策略 |
| /admin/crawl · 频道 | 频道身份、采集开关、间隔、公共发布、频道 DSL、独立或继承的出站策略 |
| /admin/crawl · 任务 | 频道 / 状态 / 类型 / 时间筛选、任务抽屉、诊断、取消、重试 |
| /admin/crawl · 待复核 | 按发布时间查看解析失败 / 待复核消息，进入共用消息抽屉 |
| TG 采集 · 采集设置 | 默认出站策略和默认解析模板，分别保存、分别跟踪未保存修改 |

TG 维护只有工作台一个入口。原来源 ID 和搜索发布绑定保留，不重建身份；实时来源列表不显示 TG，旧来源保存接口也不能绕过工作台修改 TG 配置。当前本机为 4 个实时来源、13 个采集频道、4 个真实节点。

采集和发布独立：暂停不取消已入库资源的公共发布；用户请求频道不会自动公开。归档保留历史消息、资源和任务，存在有效用户采集意向时不能静默归档。

### shadcn UI 与复用

- 共用已有 AdminLayout、Sidebar、Button、Tabs、Dialog / Sheet、Select 等后台组件；不增加第二套后台导航。
- 来源与频道共用 OutboundPolicyEditor，节点只读引用可跳到所属对象。
- crawl.vue 管理页签和 URL 抽屉状态，每次只挂载一个主要工作区、一个主弹层。
- 频道编辑、消息、任务详情不再依次堆叠到页面底部；消息详情可返回消息列表。
- 弹层字段区独立滚动，底部操作固定；窄屏表格允许横向滚动并提供提示。
- 加载 / 空结果 / 错误各自显示；保存失败保留草稿；并发版本冲突返回409，不覆盖其他管理员修改。
- useCrawlQuery 取消旧请求、丢弃过期响应，仅挂载且页面可见时轮询；权限失败停止轮询，普通刷新失败保留旧数据及错误提示。普通失败暂未实现指数退避。

## 2. 后端执行语义

src/outbound.rs 是实时来源与采集共用的出站服务，配置归属 source / channel / TG default。

- direct：明确直连；proxy：明确选择节点；inherit：仅频道继承 TG 默认。
- ordered 保留成员顺序；weighted 按权重概率选择，不再等同于每次选最大权重。
- unavailableFallback 只控制无可用节点时是否直连；fallback 控制尝试代理后失败是否直连，两者不能混用。
- 配置读取失败或缺失不暗中转直连；节点每日额度请求前原子预留，所有引用方共享额度。
- 半开探测使用带过期时间的租约；429 不轮换节点绕过上游限流。
- 最多尝试1–5次；总超时预算不会因重试重复累加。POST 默认不可重放，显式 replaySafe 才允许多次尝试。
- 策略版本与节点成员在同一 SQL / MVCC 快照读取，写入校验版本。
- 有引用节点禁止删除，返回409；兼容 PostgreSQL 外键 RESTRICT 的23001和23503错误码。

TG 搜索仍查询本地 PostgreSQL / Redis；只有 worker 抓取页面走频道出站策略，不恢复逐频道网络搜索。公共 SearchResult、JSON统计和 SSE 逐来源返回契约由回归测试约束。

## 3. 消息解析和任务

- 频道 DSL 是采集配置权威来源；空频道规则使用默认模板，不再从任意同频道来源挑规则。
- 消息预览与真实采集共用纯解析服务、资源清洗和时间处理；只读预览不改资源、来源关系或索引版本。
- 预览最多并行2个，单次超时15秒。
- 消息摘要来自消息正文选择器，不使用频道介绍；原文返回 rawText，HTML作为转义代码显示，不执行HTML。
- 已存资源、规则预览、消息原文分别展示。原文/消息摘要允许保留原始分享链接；可搜索资源仍按统一清洗规则拆出 links，避免 HTML 和分享链接混入标题/描述。
- DSL 保存不自动重写历史；支持显式频道重解析和单条消息重解析。单条任务不修改同频道其他消息。
- 频道任务提交使用持久 requestKey；同 key / 同参数返回原任务，同 key / 不同参数409。单条重解析采用活动任务唯一约束，重复活动提交409，不宣称所有操作都有 requestKey 幂等。
- worker 使用 Redis 心跳，约10秒更新，45秒过期；概览区分在线、离线、无法确认。
- 删除周期性全表发现；用户保存自定义频道时显式登记，按有效采集意向租期调度。已有用户频道策略有独立迁移快照。

## 4. 显式管理接口

下列路径均以 /api 开头，要求管理员会话；成功采用 code / data / message 包装。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /admin/crawl/overview | 心跳与任务/复核计数 |
| GET / POST | /admin/crawl/channels | 频道分页 / 创建 |
| GET / PUT | /admin/crawl/channels/{channel} | 详情 / 版本校验保存 |
| POST | /admin/crawl/channels/{channel}/archive | 归档 |
| GET / PUT | /admin/crawl/default-outbound | TG 默认策略 |
| GET / PUT | /settings/source-template | 默认 DSL，带版本校验 |
| POST | /admin/crawl/channels/{channel}/jobs | 创建任务 |
| GET | /admin/crawl/jobs | 任务筛选、游标分页 |
| GET | /admin/crawl/jobs/{id} | 任务详情 |
| POST | /admin/crawl/jobs/{id}/cancel | 取消 |
| POST | /admin/crawl/jobs/{id}/retry | 重试 |
| GET | /admin/crawl/channels/{channel}/messages | 消息列表 |
| GET | /admin/crawl/channels/{channel}/messages/{id} | 消息详情与已存资源 |
| POST | /admin/crawl/channels/{channel}/messages/{id}/preview | 只读规则预览 |
| POST | /admin/crawl/channels/{channel}/messages/{id}/reparse | 单条重解析 |
| GET | /admin/crawl/review | 跨频道待复核 |
| GET | /admin/proxies/{id}/references | 节点只读引用 |

频道使用 page / pageSize（最大100）。任务、消息和复核使用 limit（最大100）、cursor，返回 items / hasMore / nextCursor。cursor为不透明 Base64url 编码，客户端不得拆分构造；无效或跨种类游标400。任务按ID倒序，频道消息按消息ID倒序，跨频道复核按发布时间倒序、频道和消息ID稳定打破同时间并列。时间筛选 from / to 接收明确时区，前端将 datetime-local 转换成UTC。

## 5. 迁移及本机数据验收

新增006_crawl_workbench.sql、007_workbench_write_guards.sql。migration-preflight模式只读取并报告 canMigrate、DSL冲突、同频道策略冲突、歧义直连排序；它不执行迁移。

本机升级先停止旧 API / worker，制作 PostgreSQL 备份，再应用006/007。恢复 worker 前核对：

| 升级前基线 | 数量 | 迁移后恢复worker前 |
| --- | ---: | --- |
| 原来源记录 | 14（4实时 + 10 TG绑定） | 一致 |
| TG频道 | 13 | 一致 |
| 消息 | 70,499 | 一致 |
| 资源 | 38,478 | 一致 |
| 消息资源关系 | 66,387 | 一致 |
| 历史任务 | 667 | 一致 |

不仅核对数量，还核对全部资源/消息/来源关系内容摘要、原来源ID与发布开关、频道最新/最旧消息、启用状态、下次同步及覆盖检查点，均一致。恢复采集后这些数量会自然增长，以上不是当前实时统计。

旧 weight DESC / node ID DESC 迁为 ordered 原顺序，不擅自改成随机。严格排末尾的空地址直连伪节点迁为 unavailableFallback=direct，尝试失败回退仍使用旧 fallback。直连优先于部分真实节点或同频道配置冲突会阻断并回滚迁移。成功后删除旧组/路由和直连伪节点，没有双写。

**本机 TG 默认策略尚未替管理员选择。** 已有13个频道保留原策略，可继续采集；新增继承默认的频道需要先在“采集设置”明确保存默认策略，未配置时失败关闭，不猜测直连。

## 6. 实际测试结果

2026-09-30，本机已执行：

- cargo fmt --check：通过。
- cargo build：通过，正常开发二进制已更新并启动。
- cargo test：37通过，2个隔离集成测试默认忽略。
- cargo test telegram_tests -- --ignored --nocapture --test-threads=1：专用测试库 + 独立Redis测试逻辑库，2通过。合计39项Rust测试通过。
- frontend npm run typecheck、npm test、npm run build：通过；前端36项测试通过。

隔离集成覆盖原JSON/SSE契约、TG搜索不联网、混合流先返回本地结果、解析清洗、只读预览不改索引、单条重解析执行、并发版本冲突、节点引用删除409、额度原子竞争、缺失默认失败关闭、暂停不取消发布、实时来源保存保留TG发布、持久任务幂等和时间并列游标分页。

真实运行服务只读冒烟：健康、概览、频道、任务、复核、来源、节点和默认策略接口200；worker在线；任务及复核第二页200且数据不同。有效JSON的 POST /api/search 无Session返回401，GET /api/search/json 无Session返回401。此处不把请求格式错误的422或错误方法405当权限验证。

浏览器检查覆盖1280×720、390×844、320×740及1280×480：频道/任务/复核、节点引用、来源/频道编辑、设置、消息详情与返回、复核下一批；窄屏和短屏抽屉无页面横向溢出，操作栏可达。真实服务最后一轮页面无控制台warn/error。写入功能在隔离库验证，真实库浏览器只读检查，未提交测试数据。

首页关键文件与改造前SHA256基线一致：app.vue、assets/source-console.css、pages/index/index.vue、pages/copyright.vue（均位于frontend）。

## 7. 当前边界与后续优化

- 这轮不提供批量批准聚合消息、原文自动保留策略、全量重解析快照发布审批、任意URL节点探测、SOCKS5节点。
- worker保持保守分页处理，未完成百万资源或千频道吞吐量验收。
- 频道列表实时统计仍有多次查询/关联计数；本机13频道约0.9–1.1秒，并出现SQL慢查询告警，后续应做统计汇总或按需加载，不宣称性能问题全部解决。采集写资源在本机并发读写时也有慢SQL告警。
- 公开TG页面存在历史边界、重定向/访问限制；任务中的上游失败会如实显示，不能承诺所有频道都成功，也不绕过限流/访问控制。
- 设计文档保留更完整需求与扩展项；本实施记录说明实际落地范围，而非把每个未来需求都标为已完成。

启动、升级命令与环境变量见项目README。测试必须使用可丢弃且名字以_test结尾的专用PostgreSQL库及独立Redis逻辑库，禁止指向业务数据。
