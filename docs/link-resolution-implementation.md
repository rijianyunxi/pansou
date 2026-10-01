# 链接交付：开发交付与运行说明

日期：2026-09-30；更新：2026-10-01；分支：`rust`。需求依据：[开发方案](link-resolution-design.md)。

## 已完成

- `/api/search` SSE 与管理员 `/api/search/json` 均为 `contractVersion=2`；所有结果，包括 `sources[].results`，只返回会话绑定的 `resultRef/linkRef/linkKey/dedupKey` 与有效性，不返回链接、提取码和 `tags` 字段。标题、简介也清理分享信息；当前公开图片数组为空，避免图片参数泄漏。内部/管理员标签不删除。
- 百度、夸克点击时先核验精确自产映射，再核验原分享并按需转存/分享。有效自产分享不受原分享失效拦截；其他失败回退原始 URL/密码。没有可用自产分享且原分享明确失效/资源不存在时，响应完全省略 `url/password`。
- 其他平台直接返回原链接，保持 `validity=-1`，不借机调用百度/夸克。
- 同一请求使用持久化幂等键。HTTP 最多等待 15 秒，超过返回 202；客户端随后只查询原键。单工作流预算 60 秒，重启/超时后的请求由轮询或 worker 安全终结，不盲目重放云端写入。
- 自产分享在配置期限内跨请求复用，不续期；临近到期不交付。已转存但取分享密码失败时，可使用已记录的分享 ID 恢复，不能重复转存。网盘写操作与旧管理员接口、账号配置使用同一 PostgreSQL advisory lock。
- 网站和小程序始终显示打开/复制两按钮，共用取链与轮询流程，得到链接后分别跳转/复制（含提取码）。仅获取中同时禁用，历史原链状态不拦截点击；确认失效提示原因，可在下次点击重试。新点击使用新键核验自产分享，未结束/响应丢失的请求仍轮询原键。到期删除客户端 URL，页面离开停止轮询；更换 Session 必须重新搜索。小程序打开使用独立 web-view 页，遇到微信不支持的域名/协议明确提示。
- 后台资源页去掉检测/转存/云端删除入口；保留本地编辑、启停、删除和旧管理员 API。系统设置的网盘账号区域增加交付策略表单。
- `link-worker` 分离同步、检测、清理和维护循环。采集/编辑通过数据库事务 outbox 入队，不阻塞采集去检测；后台检测不转存。原链接每日限额、平台间隔、异常退避和登录/限频熔断生效。
- 创建产物之前登记到期清理任务。任务撤销记录的自产分享，只删除本流程独立子目录；目录身份/全量文件树不一致、Cookie 变化或写入归属不确定时阻止删除，保存 blocked 记录。

## 接口

所有取链/状态接口要求有效 Session；匿名和登录用户均可。引用 TTL 30 分钟，不能跨 Session 使用。响应含 `Cache-Control: private, no-store`，包括错误。

| 接口 | 方法 | 请求 |
| --- | --- | --- |
| `/api/links/resolve` | POST | `{resultRef,linkRef,requestKey}`；requestKey 为 UUID |
| `/api/links/resolve-operations/{requestKey}` | GET | 原 Session 查询原任务 |
| `/api/links/status` | POST | `{items:[{resultRef,linkRef}]}`，最多 50 条，只查状态 |
| `/api/resources/status` | POST | `{resultRefs:[...]}`，最多 50 个，仅汇总该引用授权可见的链接 |
| `/api/settings/link-delivery` | GET/PUT | 管理员交付配置 |
| `/api/settings/link-check` | GET/PUT | 管理员后台原链接检测配置 |

取链返回 `data.status=processing/completed/unavailable`，`delivery=reshared/original/null`。已失效结果仍是 HTTP 200 的业务结论，鉴权/引用变更等错误使用 401/403/409/410。状态批量查询逐项返回结果或 `errorCode`，从不返回 URL，不触发转存。

有效性：`-1` 未检测/无法确定/已过期，`0` 原分享明确失效或资源不存在，`1` 有效。网络、登录、密码、限频或上游错误均覆盖当前状态为 -1 并清空有效期，不沿用旧 0/1；原检测时间仅供诊断。原分享与自产分享状态独立。资源汇总：任一链接有效则 1；非空且全部明确失效才为 0；其他为 -1。

## 数据库

以 [011_link_resolution.sql](../migrations/011_link_resolution.sql) 为实际字段/索引/约束的权威来源，不改动 migrations 001–010。

| 表/字段 | 用途 |
| --- | --- |
| `managed_resources.link_validity SMALLINT DEFAULT -1` | 后台资源级数值汇总，约束 -1/0/1 |
| `managed_resources.link_validity_updated_at TIMESTAMPTZ` | 最近汇总依据的检测时间 |
| `managed_resources.links_revision BIGINT DEFAULT 1` | 链接/手工覆盖变化时递增 |
| `link_catalog` | URL/密码输入指纹唯一目录，数值事实、有效期、尝试时间、错误、退避 |
| `resource_link_bindings` | managed 与 occurrence 范围分别关联，不替代公开授权快照 |
| `link_share_cache` | 每次交付产物、账号/策略指纹、文件树证据、自有分享 ID、有限期限、状态 |
| `link_resolve_requests` | Session 摘要+请求键唯一，授权快照、持久响应、60秒截止、7天保留 |
| `link_check_jobs` | 原链接检测任务、输入版本、租约、重试；reshared 类型预留 |
| `link_cleanup_jobs` | 到期撤销/删除、阶段进度、租约、重试与 blocked |
| `link_sync_queue` | 事务 outbox；历史数据分批回填、重启可续跑 |
| `policy_settings` | `link-delivery` 与 `link-check` 强类型配置 |

输入变化生成不同 catalog 指纹，当前 catalog 输入不可变，`input_version=1`；不是在旧 URL 行上覆盖密码。原 `resource_links`、资源正文和原链接保留。

本地库已应用 011。迁移前校验历史表结构与干净 001–010 对齐；迁移前资源数量 57,928、resource_links 87,566、occurrences 103,688。迁移前备份：`/Users/song/Desktop/pansou_before_link_resolution_20260930_v011.dump`（PostgreSQL custom 格式，约 165 MiB）。本次没有重置库或改历史迁移校验记录。

## 配置与启动

后台「系统设置 → 云端操作」中，保存 Cookie 后保留原转存开关，再选择项目专用目录；高级设置可手填百度路径/夸克 fid，不能选根目录。服务会在父目录下创建 `pansou-UUID` 独立子目录。账号凭据区默认收起，目录和保留期只在开启对应功能后展开。

示例仅说明格式，不代表已启用：

```json
{
  "revision": 1,
  "quark": {
    "enabled": true,
    "targetDir": "项目目录fid",
    "deliveryTtlSeconds": 86400,
    "deliveryMinRemainingSeconds": 300,
    "platformShareDays": 7
  },
  "baidu": { "enabled": false }
}
```

保存时服务端递增策略 revision，旧产物仍使用其创建时的保留快照。期限限制 60 秒到 30 天，临期窗口须小于保留期限。百度平台期限支持 1/7/30 天；夸克发送明确 `expired_at`。应用截止返回 `deliveryExpiresAt`；夸克另返回提交的 `shareExpiresAt`，百度响应未提供可核实的绝对时间则返回 null，不伪造准确时间。

检测配置默认：关闭后台检测，有效结论 1 天、失效结论 7 天，每个平台间隔至少 2 秒，每个平台每天最多 1000 次。检测开关只控制后台扫描，用时检测仍可执行。未确认目录与保留时间时，自动转存默认关闭；不能因为后台检测关闭就认为不会调用原分享检测接口。

在项目根目录运行，配置 `PANSOU_DATABASE_URL` 与 `PANSOU_REDIS_URL`：

```sh
cargo build
cd frontend
npm run build
cd ..
./target/debug/pansou-api serve
# serve 默认同时启动 TG 采集与链接同步/检测/清理，无需另开终端。
```

serve 默认启动完整后台处理；独立部署时关闭内嵌再另启 `worker`/`link-worker`。本地同步每批最多 50 个资源或约 200ms（单个资源事务不可中断），批次间隔 2 秒；巡检/清理间隔 2 秒，维护约 30 秒。014 为同步队列增加排序索引、为有效性结论增加过期索引；同步差量更新关联、单个资源内去重登记链接并复用已有关联的链接记录 ID，已有链接的 last_seen_at 最多每小时更新一次。检测结果变化与受影响资源汇总在同一事务更新，新关联在同一事务刷新汇总；维护只处理每批最多 100 条过期结论，不再周期性全库汇总。无需等全量回填才可取链。旧 `background-workers.linkEnabled` 现只控制应急暂停清理，接口兼容 `links` 并新增 `cleanup`；关闭转存/巡检不取消清理。监控分别展示服务心跳、最近 24 小时点击结果、巡检队列、清理队列与本地关联。

本机 API 与构建后的 Vue 网站统一提供于 `http://127.0.0.1:3666/`；无需额外 Vite 进程。PostgreSQL/Redis 继续使用已有 Docker 容器，本机 Docker 当前由 OrbStack 提供。

交付时 serve 和 link-worker 均已启动，历史关联回填正在后台进行。运行检查已观察到 pending_sync 从 57,928 降到 57,303、catalog 895 条、bindings 2,792 条；真实云盘产物为 0，原资源仍 57,928 条。以上是一次进度快照，不表示回填已经结束；重启 worker 会从剩余队列继续。

## 测试与验收边界

```sh
cargo test
PANSOU_TEST_DATABASE_URL=postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/pansou_link_test \
PANSOU_TEST_REDIS_URL=redis://127.0.0.1:6379/14 \
cargo test -- --ignored --test-threads=1
cd frontend
npm run typecheck
npm test
npm run build
cd ../miniprogram
npm test
```

2026-10-01 验证：Rust 单元测试 56 项、隔离 PostgreSQL/Redis 集成测试 5 项、网站测试 65 项、小程序基础 smoke 与 7 项交互测试通过；网站类型检查和构建通过，桌面/375px 页面无横向溢出。覆盖检测异常将旧 0/1 覆盖为 -1、原链失效继续复用自产分享、策略修订/关闭新转存仍可复用、原链异常回退、空资源报错、80% 后台预算与 20% 点击预留、清理暂停不阻止本地同步。集成测试仅使用 `_test` 库、Redis 非 0 库和本地模拟网盘，不操作真实账号。

2026-10-01 性能修订验证：56 项单元测试、6 项隔离集成测试通过，新增测试覆盖差量关联不改变未变化行的 xmin、同一作用域链接去重、已有检测结果传播、结论过期、空关联回到 -1，以及并发检测与资源汇总的一致性。014 已在本地应用，队列领取使用 `link_sync_queue_order`，过期探测使用 `link_catalog_expiry`。本地 10:37:36–10:44:02（UTC+8）`temp_files=65921`、`temp_bytes=217647873989` 均未增长；这是数据库累计临时写入计数，不是磁盘当前占用。最终采样 PostgreSQL CPU 11.87%、API CPU 4.7%，会随采集负载变化，并非固定上限。保持 TG 采集开启、转存/后台检测/清理关闭，真实云盘产物仍为 0；后台关联继续处理（最终两次快照 1294 → 1248）。

已覆盖公开字段清理、跨会话拒绝、明确失效无 URL/密码、其他平台原链、持久幂等、分享密码失败恢复、并发请求不重复转存、复用不续期、到期撤销/删除、旧键不返回已清理分享、未知文件阻止删除、链接变更拒绝。百度/夸克目录创建、有限期参数和撤销接口均有模拟测试。

本地 HTTP 验证使用已有 UC 资源：v2 SSE 结果无 URL/密码；resolve 返回原始 UC 链接；status 返回 -1 且不带 URL。按钮测试覆盖打开/复制共用取链、复制对应提取码、失效提示且不执行跳转/复制、失败关闭预留页面和剪贴板拒绝时不误报成功。

2026-09-30 按钮优化后的本地 HTTP 验证：`/api/search` SSE 未返回 `tags`；浏览器每条资源均有打开/复制按钮，未发现标签及未检测/待确认文案。实际点击 UC 复制按钮后显示“已复制”且剪贴板包含 UC 链接；点击打开按钮后新页进入相同 UC 分享。

必须区分模拟测试与实盘：本次未使用真实账号创建/撤销分享或删除云盘文件，也未在微信开发者工具/真机完整联网验收。启用前请准备明确的专用测试目录与测试分享，验证平台响应、限频、期限和实际配额变化；小程序发布前将 `utils/config.js` 的 localhost 改为合法 HTTPS 请求域名。

## 保守策略与尚未覆盖的增强项

- 账号隔离目前使用 Cookie 凭据指纹，任何 Cookie 改变都会阻止复用与旧产物自动清理；没有自动认定「新 Cookie 属于同一真实账号」。这比设计中的真实账号 ID/revision 模型更保守，但换 Cookie 后需要人工核实旧产物，不可直接放行 blocked 任务。
- 后台定时检测当前处理原链接；自产分享在每次新请求复用时重新核验，重放还检查缓存状态、账号与平台/应用期限。数据库预留 reshared 检测任务类型，尚未启用独立自产分享周期扫描。
- 已知保存结果/分享 ID 可恢复；目录创建、转存或创建分享响应丢失且无法证明归属时保留 uncertain/blocked，停止重复写入和自动删除。未实现所有上游异步任务的自动只读核销；不要通过删除数据库记录来“重试”。
- 删除可能进入平台回收站，不能承诺立刻释放全部容量。当前不会清空整个账号回收站，也不会永久删除本流程以外的文件。
- 没有积分、兑换、扣费或账户余额模型；以后在统一 resolve 授权入口接入。

排查队列时只读查询任务状态和脱敏错误，不打印 Cookie、原 URL/密码、授权快照。例如：

```sql
SELECT count(*) AS pending_sync FROM link_sync_queue;
SELECT status, count(*) FROM link_check_jobs GROUP BY status;
SELECT status, last_error_code, count(*) FROM link_cleanup_jobs GROUP BY status, last_error_code;
SELECT state, count(*) FROM link_share_cache GROUP BY state;
```

blocked 意味着等待核实，不意味着清理成功。清理失败最多尝试 5 次，间隔 30 分钟；账号/归属冲突立即 blocked。只有在确认目录、文件树、自有分享身份与账号均匹配后，才可考虑恢复任务。
