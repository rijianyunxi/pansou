# SQL 设计与查询性能审计

> 2026-10-02 更新：本文件记录当时的审计/验证。原文保存、摘要与规则预览已按新需求移除，迁移 019 删除旧原文列；参见 [原文存储清理](source-message-storage-cleanup.md)。文中关于保留原文和冷热分离的建议不再适用。

后续状态：2026-10-02 已实现第一批修复；具体范围、验证与仍未实施事项见
[SQL 优化验证](/Users/song/study/pansou/docs/sql-optimization-verification.md)。下文保留审计当时的运行状态与原查询测量。

日期：2026-10-01。范围：迁移与最终数据库索引、生产代码的 SQL 查询入口，以及搜索、采集、后台、链接同步/检查/交付、账户与设置的访问模式。

本轮只做静态检查与只读诊断，没有执行业务写入、迁移、索引删除、容器重建或数据库配置变更。不是每条 SQL、每种参数都完成压测；大表热点使用 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` 取样，其他项明确标为结构性风险。执行计划测试绕过应用缓存，时间是数据库执行时间，不是 HTTP 响应时间；缓存冷热与后台负载影响结果，不能作为固定延迟保证。

## 结论与优先级

还有明确的优化空间。主要问题是宽数据过早关联、页面请求重复统计、写事务串行化、队列选择与索引顺序不匹配，以及运行配置未生效；不是简单地给每张表再加索引。

| 优先级 | 项目 | 证据 | 主要方向 |
| --- | --- | --- | --- |
| P1 | 高频词本地搜索 | “电影”执行约 3,210ms；“三体”约 57ms | 窄候选集过滤/排序/去重后再读取完整 JSON |
| P1 | 纯符号搜索退化 | 并行执行遇到共享内存不足；诊断会话关闭并行后超过 8 秒 | 明确关键词支持规则，为无 gram 的路径提供有界策略 |
| P1 | 资源管理页面附属统计 | 网盘类型下拉数据约 1,400ms，扫描约 40 万资源 | 元数据缓存或小型维表，避免每页扫描 |
| P1 | 运行内存预算 | 搜索 `work_mem=64MB`；容器 `/dev/shm` 实际 256MiB，Compose 为 1GiB | 核实部署配置、数据库搜索并发预算，不能仅调高内存 |
| P2 | 监控统计 | 未缓存的链接健康聚合约 402ms | 缓存/合并统计，保留心跳实时性 |
| P2 | 写入与缓存版本 | 所有关键写入共用版本行锁；语句级版本触发器更新 0 行也触发 | 减少锁内工作、无效写入与无效失效，再评估锁拆分 |
| P2 | 链接检查调度 | 只读候选 SELECT 约 199ms，约 24.7 万次 job 索引查找 | 排序字段落到队列、匹配索引，避免重复入队冲突 |
| P2 | 索引与分页 | 三个旧资源索引合计约 263MiB；第 1000 页约 146ms | 核实后退役旧索引、稳定游标分页 |
| P3 | 存储与保留策略 | 消息 TOAST 约 5.2GiB；gram 索引约 2.3GiB | 原文冷热分离、历史保留策略、长期评估内部整数 ID |
| P3 | 性能观测 | 未启用 `pg_stat_statements`，历史临时写入累计 237GiB | SQL 指纹统计和慢查询观察，建立基线 |

P1 表示已经复现的明显慢查询/失败风险；P2 是明确的中期收益或结构性风险；P3 暂不建议为此大规模重构。

## 当前数据与运行状态

数据库为 PostgreSQL 18.6。当前业务库迁移版本仍为 **15**；上一轮新增的迁移 016 已在源码和隔离测试验证，但尚未在这个业务库应用。不能把隔离测试里的频道查询速度当作当前服务已经生效的速度。

| 表 | 估计活行数 | 含索引/TOAST 大小 |
| --- | ---: | ---: |
| source_messages | 1,346,283 | 5,810MiB |
| resource_grams | 13,835,094 | 3,280MiB |
| resource_occurrences | 1,172,349 | 1,374MiB |
| resource_link_bindings | 2,057,365 | 861MiB |
| managed_resources | 396,376 | 852MiB |
| link_catalog | 359,545 | 186MiB |
| link_check_jobs | 约 247,000 | 55MiB |

以上行数来自 `pg_stat_user_tables`，不是一致性快照下的精确 COUNT。检查队列精确观察到 246,994 条 queued；链接检查策略当前关闭，这不能直接解释为执行失败。采集任务当前 3,229 条，均为 completed。

默认数据库 `work_mem=4MB`、`shared_buffers=512MB`、`max_parallel_workers_per_gather=2`、`max_connections=100`。应用连接池默认上限 32；用户策略已有 Redis 全局搜索并发控制，默认 64，不能误称“没有并发限制”。它限制搜索请求，不是数据库排序/哈希工作量。

## 1. 搜索：最优先改造查询形态

入口：[local_index.rs](/Users/song/study/pansou/src/local_index.rs:16)；SQL：[telegram_search_gram.sql](/Users/song/study/pansou/src/queries/telegram_search_gram.sql:1)、[telegram_search.sql](/Users/song/study/pansou/src/queries/telegram_search.sql:1)。

### 已复现

在相同 10 个本地频道范围内：

- “三体”：35 个 gram 候选资源，最终 34 个资源；执行 57.497ms，规划 12.308ms。
- “电影”：5,839 个 gram 候选资源，关联 11,588 条消息/出现记录，去重得到 5,796 个资源后才返回 200 个；执行 3,209.702ms。计划累计读取 25,330 个共享块，约 198MiB；本次无临时文件。
- 中间关联结果估计行宽约 1,544 字节，包含出现记录的完整 JSON 和资源展示字段；同时产生数千次资源/出现记录索引查找、上万次消息索引查找。

索引命中了，但候选集仍大，后续宽表取数、关联、去重与排序占主导。`LIMIT 200` 没有把前面的工作限制到 200 条。

### 建议

1. 为出现记录维护紧凑的搜索投影：规范化名称、发生时间、解析可见性、频道/消息/资源键。候选阶段不要带描述、链接、标签、图片、完整 `result_json`。
2. 先在窄投影里校验名称、频道范围，按现有语义选每个资源的出现记录并排名，最后对选中的 200 条读取展示 JSON。需要检查执行计划，不能仅套几层可能被内联的 CTE 就视为优化完成。
3. 长关键词当前按 BTreeSet 字典序选第一个合适的二元 gram，不考虑频率。可选择更有区分度的 gram 或做多个 gram 的交集；最终仍必须校验完整名称，保证不会把 gram 命中当成真正匹配。不要每次为了选 gram 又全量统计词频。
4. 纯符号关键词没有 gram，进入全量关联路径。“!!!”只读诊断在并行时触发 `/PostgreSQL.*` 共享内存分配失败；仅对该诊断事务关闭并行后，超过 8 秒超时。此时间不是默认并行路径的耗时。应明确该类关键词是否支持；若支持，需要独立有界检索策略，不能随意截断候选而漏掉合法资源。
5. 保留频道权限范围、仅名称匹配、manual_override 优先、隐藏资源排除、最新匹配出现记录与排序规则。不得用全局最新展示数据替代用户授权频道内的出现记录。

### 缓存与连接占用

本地搜索先开启只读 REPEATABLE READ 事务、读取全局版本，再访问 Redis；命中 Redis 也要占 PostgreSQL 连接，Redis 读写等待处于事务生命周期内。缓存键含全局 local-index revision，任意频道更新会使全部频道组合的缓存失效；当前路径没有同一 key 的 miss 合并。

建议先解决无效版本递增，再评估频道级版本和 singleflight。缓存读移出长事务时，要验证“版本与结果属于同一快照”的一致性，不能简单调换两个 await 的顺序。

## 2. 资源管理：页面本身很快，附属查询很慢

位置：[admin.rs](/Users/song/study/pansou/src/handlers/admin.rs:83)。三条 SQL 串行执行：资源列表、精确总数、网盘类型列表。

| SQL | 执行观察 |
| --- | ---: |
| 无筛选第一页，20 条 | 0.698ms |
| 无筛选精确 COUNT | 60.877ms |
| DISTINCT jsonb_array_elements_text(cloud_types_json) | 1,400.415ms |
| 第 1000 页，OFFSET 19,980 | 145.885ms |

网盘类型查询扫描约 40 万行、展开约 60 万个 JSON 数组元素，只得到 12 个选项，读取约 387MiB 共享块。页面首次/再次访问都会执行，查询也不随分页变化。

建议：

- 将类型选项做短 TTL 缓存并合并并发刷新，或维护小型类型维表/引用计数。若改为“所有支持类型”固定枚举，需要先确认产品接受它与“数据中实际存在的类型”之间的区别。
- 无筛选 COUNT 可缓存/维护汇总；筛选后的总数必须对应筛选，不能套用全库计数。可考虑返回 hasMore 的交互设计，但这属于接口契约调整。
- 使用 `(updated_at DESC,id DESC)` 稳定排序；大页改为同字段游标，并匹配 `WHERE deleted_at IS NULL` 的复合索引。现有 OFFSET 会持续读取和丢弃前面的行，只有 updated_at 的排序在同时间戳时也不稳定。
- 按真正存在的筛选条件构造绑定参数 SQL，减少 `($1='' OR ...)`。只读强制计划对比中，“流浪地球”的 custom plan 用名称 GIN，generic plan 用 updated_at 索引并逐行过滤。这里只证明存在计划风险，没有证明线上连接已经切换为 generic plan。
- 两字关键词“三体”的 custom plan 也选择并行扫描：不能指望 trigram GIN 对所有短中文查询都有效。可评估已有 gram 表预过滤，再用原名称条件验证。

## 3. 监控：补齐缓存覆盖，不必做所有字段的精确实时聚合

位置：[monitoring.rs](/Users/song/study/pansou/src/handlers/monitoring.rs:83)、[admin_stats.rs](/Users/song/study/pansou/src/admin_stats.rs:90)。

- 主体资源/链接有效性聚合已有 60 秒缓存；一次未命中 SQL 约 105.449ms。
- `check_health` 没有缓存，扫描链接表，约 402.382ms；该次读取约 97MiB 共享块。
- 检查队列 GROUP BY 约 22.566ms；同步队列 COUNT/MIN 约 6.413ms，暂不是主瓶颈。
- 最近失败查询返回 0 行仍扫描 link_catalog，热缓存约 39.052ms。可用匹配 `failure_count>0 AND last_error_code IS NOT NULL` 的 last_attempt_at 部分索引；先评估失败记录规模与轮询频率。

建议把低频变化的大表统计合并到 10–30 秒级缓存/汇总，避免多标签页同时刷新；心跳、任务状态继续实时。TTL 到期会改变“有效/到期”计数，不能只按数据库 UPDATE 维护静态计数而忽略时间推进。

## 4. 采集写入：锁内工作和触发器放大值得优化

位置：[crawl.rs](/Users/song/study/pansou/src/crawl.rs:339)、[worker.rs](/Users/song/study/pansou/src/link_resolution/worker.rs:157)、[迁移 013](/Users/song/study/pansou/migrations/013_crawl_commit_lock_order.sql:1)。

### 结构性风险

采集提交、链接同步、链接检查结果汇总和到期维护都会拿同一个 `config_revisions(scope='local-index')` 行锁。HTTP 拉取可以并行，但关键数据库提交串行。诊断时没有正在等待的业务连接，所以这里是并发能力风险，不是已经测得的锁等待时长。

该版本行历史累计更新约 278 万次。迁移 013 的 managed_resource_revision 是 BEFORE、FOR EACH STATEMENT，且函数无条件递增：即使 UPDATE 的 WHERE/IS DISTINCT FROM 最终排除了所有行，或 INSERT 冲突后没有新增行，仍可能失效缓存。采集函数还显式 bump，同一事务可多次递增。

PostgreSQL 明确规定语句级触发器在影响 0 行时仍执行：[触发器行为文档](https://www.postgresql.org/docs/18/trigger-definition.html)。

### 优化顺序

1. 可预计算的 HTML 解析、规范化、hash、JSON 比较尽量移到关键事务前；提交时再校验版本/租约。不要把网络调用引入事务。
2. 每页收集并去重 changed resource IDs，批量同步基础数据，对同一资源尽量只刷新一次。
3. 当前编辑/重解析删除该消息全部 occurrences 再插入，虽然新旧集合可能大量相同。改为差异 INSERT/UPDATE/DELETE，减少 outbox、引用统计、索引、WAL 与死元组 churn。解析失败时保留旧出现记录但禁止显示的现有语义必须保留。
4. 未变消息目前仍更新 last_seen_at，可按观察需求节流。资源 links/grams 已有差异更新逻辑，应保留而不是改回全量重建。
5. 失效版本改为只对真实可见变化递增，并尽量按事务/批次合并；必须覆盖管理员修改、禁用、软删除、出现记录变化与解析状态变化。不可只删除触发器，把其他写入口漏掉。
6. 最后才考虑按资源/频道拆锁。现有锁序是为防止死锁建立的，直接去锁、增加连接或多个 worker 并不能安全解决。

managed_resources 历史 526,363 次 UPDATE 中 HOT 仅 16 次，说明更新成本值得关注；这不是“已证明表严重膨胀”。变更索引列及页面可用空间都会影响 HOT，需结合 WAL/表膨胀检测再判断。

## 5. 检查队列：取一条任务不应扫描几十万候选

位置：[worker.rs](/Users/song/study/pansou/src/link_resolution/worker.rs:237)。

检查关闭时会跳过 check_tick，但同步新链接时仍会创建原链接检查任务，解释了当前约 24.7 万 queued。按需入队可减少存储，但开启策略时必须有可靠补偿补队。

开启检查后的调度存在两个问题：

- 每次从 catalog 按 next_check_at 取前 100 条，`ON CONFLICT DO NOTHING`，没有预先排除已有活动任务。同一批未完成任务可以反复成为候选并全部冲突，补队因此可能迟迟无法推进到其他链接。只读对应候选 SELECT 热缓存约 50.897ms，计划扫描约 35.9 万 catalog 行。
- 认领查询按 `priority DESC,catalog.last_seen_at DESC,run_after,id` 排序，而现有 job 索引是 `(run_after,priority,id)`。跨表排序无法由这个索引直接满足。只读 SELECT（没有执行 UPDATE，也未加 FOR UPDATE）约 199.424ms，出现约 246,987 次 job 索引查找。不能把此值当成真实上游检查耗时。

建议让调度排序需要的字段落到队列，按业务优先级建立匹配索引，分开 queued 到期与 running 租约到期处理，补队使用 anti-EXISTS 活动任务并按可用 provider/凭据/预算选候选。若按 provider 分路，要保留全局优先级语义；不能先任意取 100 条再排而悄悄改变公平性。

已完成检查任务的清理筛选也扫描整个 job 表：返回 0 行时约 17.968ms。规模增长后可考虑 completed/updated_at 部分索引和限批清理。cleanup_due 现有 `(run_after,id)` 索引与排序更匹配，但过期 running 分支仍可按规模评估租约索引，不建议现在给只有少量记录的表堆索引。

## 6. 索引清理：有候选，但不能按 idx_scan=0 直接删除

| 索引 | 大小 | 审计判断 |
| --- | ---: | --- |
| idx_managed_resources_search_trgm | 140MiB | 当前 SQL 不以 search_text 做检索，旧实现候选 |
| idx_resource_tg_name | 72MiB | 本地搜索走 gram/出现记录；后台已有 not-deleted 名称索引，退役候选 |
| idx_resource_tg_date | 51MiB | 搜索按 occurrence_date 排，不是资源全局 published_at，退役候选 |
| idx_messages_recent | 77MiB | 固定 channel_id 后 message_id DESC，主键可反向扫描；待专项验证 |
| idx_resource_name_admin | 72MiB | 必须保留：长词 custom plan 已证明能使用它 |
| resource_grams_pkey | 1,187MiB | 保留：resource→grams 的维护与唯一性 |
| idx_resource_gram_lookup | 1,119MiB | 保留：gram→resources 的检索 |

前三个索引历史 idx_scan 都为 0，合计约 263MiB。统计窗口未知，且未来查询改造可能重新用到它们，应结合 SQL/计划/实际业务周期确认，再用新迁移退役；不要修改已执行旧迁移。

主键 `(channel_id,message_id)` 反向扫描可以服务“固定频道、消息倒序”；不能推断它能服务所有混合升降序全局排序。参见 [B-tree 排序文档](https://www.postgresql.org/docs/18/indexes-ordering.html)。

gram 的两个索引不是重复索引，删除任何一个都会伤害不同方向的访问。

## 7. 存储设计与数据生命周期

### 宽数据与重复文本键

- source_messages：heap 338MiB、索引 236MiB、TOAST 5,235MiB。大部分空间在原始 HTML；适合保留原文但将热路径需要的状态/时间/摘要与冷原文分开。原文重解析需要它，不能为了快直接删。
- resource_occurrences：heap 1,067MiB、索引 306MiB。搜索只需名称/状态/日期，却要读取完整 JSON，紧凑搜索投影比继续复制展示 JSON 更有价值。
- resource_grams：heap 973MiB、索引 2,306MiB。13.8M 行反复存 TEXT resource_id，长期可考虑内部 BIGINT 代理键，保留对外资源 ID，通过映射和外键维护。属于高成本迁移，不是本次第一步。
- resource_link_bindings：heap 372MiB、索引 490MiB。scope_key 含频道/消息文本，长期可评估显式 scope_type/channel/message 字段，减少重复字符串；需先证明瓶颈。

### 保留与清理

生产路径有 resolve 请求过期清理及 completed check jobs 七天清理；但未找到 cloud_delete_previews、cloud_drive_operations 的定期物理清理。它们虽然有 expires_at，过期检查不等于删除。search_logs、completed crawl jobs、已删除 share-cache/cleanup 历史也需要明确保留/归档策略。

不能统一“过期就删”：网盘操作的 request_key 用于幂等和不确定操作追踪，share-cache/cleanup 有外键与所有权证据。应先确定去重窗口、审计保留、引用安全，再分批归档/删除。

目前用户、来源、代理、日志等表很小，账户主键/唯一键读取不是热点。搜索日志后台的多字段 OR + 用户 JOIN、全历史 analytics 汇总，在日志增长后可能退化；先建立保留/按日汇总，不建议现在为每个筛选组合添加索引。

## 8. 运行配置与观测

### 共享内存配置未一致

[docker-compose.yml](/Users/song/study/pansou/docker-compose.yml:8) 设置 `shm_size: 1g`，但 `docker inspect` 返回 268,435,456 字节，容器 `/dev/shm` 为 256MiB。搜索只读诊断复现 64MiB 共享内存段扩容失败；检查时空闲空间约 253MiB，说明瞬时峰值不能由事后空闲值排除。这是共享内存分配问题，不能直接叫“磁盘满”或断言为进程 OOM。

后续部署需要核实并应用配置差异，重建容器须保留数据库命名卷。仅重启原容器不会改变创建时的 shm 限制。本次没有重建或重启。

### 内存要按执行工作量预算

搜索的 `SET LOCAL work_mem='64MB'` 不是“整个查询最多 64MB”，多个排序/哈希节点与并行 worker、多个会话会叠加。已有请求并发限制也不能等同数据库内存预算。建议先缩小中间结果，再建立专门的数据库搜索槽位/预算，与真实内存及后台任务配额共同调整；不要全局把 work_mem 拉到 64MB，也不要直接加大连接池。

依据：[PostgreSQL 18 内存参数文档](https://www.postgresql.org/docs/18/runtime-config-resource.html)。

### 观测缺口

当前没有 pg_stat_statements，shared_preload_libraries 为空。数据库累计 temp_files=75,943、temp_bytes≈237GiB、deadlocks=1，stats_reset 未提供；这些是历史累计值，不能归因于本次某条查询，也不能据此说数据库一直在抖动。

建议在计划维护窗口启用 SQL 指纹统计，跟踪 calls、总/平均耗时、shared read、temp written、WAL，并配置适当的慢查询记录。`pg_stat_statements` 的 preload 调整需要服务器重启，本轮不实施。参见 [官方扩展说明](https://www.postgresql.org/docs/18/pgstatstatements.html)。

## 9. 已有合理设计与下一步验收

值得保留的设计：参数绑定；资源/出现记录外键与唯一性；活动任务部分唯一索引；FOR UPDATE SKIP LOCKED 与租约；原文/解析状态持久化；事务 outbox 避免采集内执行上游网络请求；链接/gram 差异更新；到期链接与隐藏资源部分索引；频道增量统计而非周期全量去重。

上一轮频道优化已有隔离对照、事务回滚和并发测试，详见 [频道统计验证](/Users/song/study/pansou/docs/channel-statistics-performance.md)。迁移 016 的引用汇总表有约 160MiB 附加空间、行触发器写入成本和一次性回填写锁；它不是没有成本的优化，升级需留出窗口。

建议执行顺序：

1. 先使已完成的频道优化在部署中生效，并核实共享内存配置。
2. 第一批代码优化：资源类型元数据缓存、监控统计缓存、搜索窄投影与延后展示取数、无 gram 策略。
3. 第二批：真实变更才失效缓存、采集差异写入/每页批量刷新、链接检查调度与索引匹配、稳定分页。
4. 最后：确认并退役旧索引、保留/归档方案、长期整数键方案、持续 SQL 观测。

验收至少包含：稀有/常见/单字/纯符号/多词关键词，分页与各类过滤，manual_override、频道授权、解析失败/恢复、禁用/软删除，缓存命中/同时未命中，采集与链接 worker 并发运行。记录 HTTP 首次及热请求 P50/P95、SQL 缓冲区和临时写入、写入吞吐、锁等待与内存峰值。不要只用热缓存中的单条 SQL 证明完成。
