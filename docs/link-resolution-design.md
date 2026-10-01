# 搜索隐藏链接、按需转存分享与链接有效性：开发方案

日期：2026-09-30；2026-10-01 按确认需求修订取链、检测异常和独立清理规则。基线：`rust` 分支 `8514277`，现有 migrations 001–010。

状态：核心功能已实现，新增 `011_link_resolution.sql` 已应用到本地数据库，网站与小程序已切换 v2 协议。本文保留设计基线与目标；实际接口、运行方式、配置项、测试证据和实现边界见 [开发交付与运行说明](link-resolution-implementation.md)。真实网盘转存/清理需配置并完成专用目录实盘验收后启用。

## 1. 需求与边界

1. 后台「网盘资源」去掉网盘工具入口、逐条及批量检测/转存/云端删除操作；保留原管理员接口和权限。资源本地编辑、启停、本地删除以及状态展示保留。系统设置中账号 Cookie 配置保留。
2. 搜索只返回资源信息与不可逆的链接标识，不返回原始分享 URL、转存分享 URL、提取码。
3. 用户选择某条分享，通过独立接口获取链接。百度、夸克执行检测→转存到运营者自己的账号→创建自己的分享→返回新链接；其他网盘直接返回原链接。
4. 优先复用精确记录且仍可用的自产分享，原分享失效不能拦截它。没有可用自产分享时，上游处理失败回退这条原链接与提取码；仅明确原分享失效/资源不存在返回失效状态且省略 URL/提取码。
5. 有效性采用 `-1 / 0 / 1`；链接级为权威事实，资源级为汇总。提供独立状态查询接口。
6. 网站、小程序使用同一协议和行为；本期不做积分、扣费、兑换、订单或余额预留。
7. 只在用户请求时转存/分享；后台检测任务仅检测，到期清理任务负责撤销分享和删除本工作流产物。
8. 自产分享和本项目转存文件只保留配置指定的时间；独立到期清理任务撤销自己的分享，并删除自己为此工作流创建的文件/目录，以控制网盘容量。

### 已确认与配置项

用户已确认匿名/登录访问、专用目录、原链接失效不返回 URL、可配置期限和自动清理。具体时间尚未确定，作为部署配置，不在代码中写死。

| 事项 | 约定 |
| --- | --- |
| 获取链接权限 | 沿用有效 Session，匿名和已登录用户均可，账户禁用/授权撤回仍拒绝 |
| 分享复用 | 方案采用仅在配置保留期内复用；命中不自动延长寿命，到期回收后下次按需重建 |
| 转存目录 | 百度与夸克各配置项目专用目录，下面按交付产物创建独立子目录 |
| 原分享失效 | 自产分享仍可用则返回它；否则返回 `validity=0`，省略 URL/提取码 |
| 小程序位置 | main 分支实际目录名是 `miniprogram/`，已复制并与 Vue 同步改造 |
| 保留时间 | 配置 `deliveryTtlSeconds` 与清理扫描间隔；未配置有效保留期前不启用自动转存 |

## 2. 设计基线代码与必须补齐的能力

| 当前实现 | 对本次工作的影响 |
| --- | --- |
| `src/models.rs` 的 `SearchResult.links` 为 URL/密码数组 | 新建公开搜索 DTO，内部采集/解析模型保持含链接 |
| `src/handlers/search.rs` SSE 与 `/api/search/json` 都输出结果，JSON 的 `sources[].results` 也含链接 | 所有公开输出路径统一做投影，不能只改顶层 `results` |
| TG 查询使用授权频道内 `resource_occurrences.result_json`，部分结果由 `manual_override` 覆盖 | 取链接必须沿用相同授权和展示版本，不能直接返回全局资源的全部链接 |
| 实时来源结果可能未入库，来源 `id` 不全局唯一 | 用服务端签发的 `resultRef/linkRef`，不能仅使用资源 ID 或数组下标 |
| `resource_links` 主键是 `(resource_id, identity)`，其填充逻辑主要在 TG 采集流程 | 新增全局链接目录及关联表，涵盖手工资源、TG occurrence 和实时结果；不假定现表已经覆盖全部来源 |
| `managed_resources.check_status/check_message/checked_at` 为已有资源级文本状态 | 新增数值字段并建立唯一写入路径，不让新旧检测各写一套结论 |
| `Drive::resolve/save/share` 已实现百度/夸克接入 | 抽取统一内部服务，复用 provider；公开接口不调用管理员 HTTP 接口 |
| `Drive::save` 可能成功转存但 `shareError` 非空 | HTTP 成功不代表拿到分享；只有真实取得新分享 URL 才可返回自产链接 |
| 010 操作表 `actor_id NOT NULL` 绑定管理员 | 公开取链接另设幂等记录，不伪造管理员 ID；管理员接口继续保留 |
| Vue 合并、卡片 key、复制和跳转均依赖原 URL | 改用服务端 `dedupKey/linkKey`，不能简单删 `url` 后沿用旧组件 |
| worker 目前处理 TG 采集 | 独立 `link-worker` 运行模式处理链接任务，避免检测阻塞采集 |

当前百度分享代码设置 `period=0`，夸克设置 `expired_type=1/expire_time=0`。本次需改成可配置分享期限，核对两平台支持的到期粒度；不能继续固定按永久分享处理。若平台不能表达所配置的时长，应用层到期停止交付，并由清理任务撤销分享；实际外部失效时间可能延迟到清理成功，应返回真实平台期限与应用期限，避免承诺精准撤销。

## 3. 接口与鉴权

### 3.1 搜索响应

保留 `POST /api/search` 的 SSE 事件结构及流式节奏，`GET /api/search/json` 同步使用新 DTO；后者继续管理员专用。新响应标记 `contractVersion: 2`，本次不保留公开返回明文链接的旧协议旁路。

```json
{
  "id": "同会话内稳定的不可逆展示ID",
  "resultRef": "服务端随机结果引用",
  "dedupKey": "同Session内相同分享集合的不可逆标识",
  "name": "资源标题",
  "description": "已清理分享URL及提取码的简介",
  "cloud_types": ["quark", "baidu"],
  "validity": -1,
  "links": [
    {
      "linkRef": "服务端随机链接引用",
      "linkKey": "同Session内稳定的分享标识",
      "type": "quark",
      "validity": -1,
      "checkedAt": null,
      "stale": false
    }
  ],
  "refsExpireAt": "ISO8601时间"
}
```

- 一条资源可以有多条同类网盘链接，每条独立选择、检测和获取。
- 搜索响应不返回 `tags` 字段（包括 SSE、JSON 顶层及嵌套结果）；内部采集与管理员标签不受影响。URL/密码只存在服务端内部模型。检查标题、简介、images、来源诊断、SSE complete/error 及嵌套结果，使用结构化白名单序列化与文本清理，去掉分享链接和提取码；不能把内部 JSON 原样透传。
- 图片仅返回通过允许规则的图片地址；不允许将分享 URL 包装成图片或下载参数泄漏。调试信息不返回原始载荷/HTML。
- `linkKey` 用规范化 URL 身份生成会话范围 HMAC；不能把 `resource_links.identity`（目前可能就是规范化 URL）直接作为公开 ID。移动云盘 URL 的 hash 属于身份，不能删除。
- `dedupKey` 根据去重后的整组 `linkKey` 排序生成，保留“仅合并完全相同分享集合”的现有行为。提取码不改变展示去重身份，但会改变检测/转存版本。
- 先缓存内部结果，再按当前会话生成 DTO/引用，禁止缓存并跨会话复用 `resultRef/linkRef`。上线切换缓存命名空间，清理客户端旧结果缓存。

### 3.2 引用与授权

Redis 保存随机引用（建议 30 分钟有效，可配置），包括 Session 的 HMAC 摘要、搜索范围、来源 ID、资源/occurrence 定位、原 URL/密码、输入指纹及版本；原文不写访问日志。

每次取链接/查状态：验证 Session→验证引用归属及期限→重查资源启用/删除、来源、频道授权与链接版本→执行处理。随机 ID、历史搜索命中或自产分享缓存都不能替代授权。引用被窃取后不得在另一 Session 使用。

实时资源使用服务端搜索快照，ID 按来源命名空间隔离；快照过期返回 `410 REF_EXPIRED`，客户端提示重新搜索。持久资源链接或密码发生变化返回 `409 LINK_CHANGED`，不得返回旧链接。用户无权访问或资源已从项目删除时返回 403/404；这与上游分享已失效是两种情况。

### 3.3 获取链接

`POST /api/links/resolve`，采用 POST 是因为可能产生云端转存、分享。

```json
{"resultRef":"...","linkRef":"...","requestKey":"UUID"}
```

不接受客户端自由提交 URL、Cookie、目标目录或网盘账号。一个请求只获取一条分享；多条并行由前端限流。

成功或原链接回退统一 HTTP 200、`code=0`：

```json
{
  "code": 0,
  "message": "链接已获取",
  "data": {
    "requestKey": "UUID",
    "status": "completed",
    "type": "quark",
    "url": "https://pan.quark.cn/s/example",
    "password": null,
    "delivery": "reshared",
    "originalValidity": 1,
    "validity": 1,
    "checkedAt": "ISO8601时间",
    "stale": false,
    "reasonCode": null,
    "deliveryExpiresAt": "配置保留期对应的ISO8601截止时间",
    "shareExpiresAt": null,
    "cacheHit": false
  }
}
```

- `delivery=reshared|original`；`validity` 描述**本次返回链接**，`originalValidity` 描述原链接。转存失败不等于原链接失效。
- 原链接明确失效且没有可用自产分享是 HTTP 200 的业务结果：`status="unavailable", delivery=null, originalValidity=0, validity=0, reasonCode="original_invalid"`（空资源为 `resource_missing`）；整个响应省略 `url/password`。前端提示对应原因但不永久禁用按钮，下次点击可重新判断。
- 自产分享另外返回 `deliveryExpiresAt`（应用保留期截止）、`shareExpiresAt`（平台真实期限）。保留期内命中不会延长截止；临近回收不再交付，避免用户拿到立即删除的链接。
- `reasonCode` 可为 `unsupported_provider / original_invalid / password_required / password_invalid / account_unavailable / rate_limited / check_failed / transfer_failed / share_failed / uncertain / deadline_exceeded / empty_share / delivery_expired`，仅返回脱敏信息。
- 上游处理超出 HTTP 等待时间（建议 15 秒）返回 202：`data={status:"processing",requestKey,pollAfterMs:1500}`。
- `GET /api/links/resolve-operations/{requestKey}` 获取最终结果，继续校验会话/权限；完成后重放同一响应。
- 工作流总预算建议 60 秒（含排队、上游重试和轮询），超过即落库为原链接回退；已经明确判定原链接失效则只能返回 unavailable。202 表示尚未结束，不是出错后继续拖延。客户端建议 75 秒轮询预算，超时可稍后查同一编号。
- 鉴权失败、限流、无效参数、项目资源不存在、引用过期等返回常规 4xx；数据库/Redis 故障且不能安全确认授权则返回 503。这些情况不能靠“回退原链接”绕过访问控制。
- 请求响应及状态查询均 `Cache-Control: private, no-store`；不让 CDN 缓存按用户授权的链接。

原分享失效的完整响应示例：

```json
{
  "code": 0,
  "message": "原分享已失效",
  "data": {
    "requestKey": "UUID",
    "status": "unavailable",
    "type": "baidu",
    "delivery": null,
    "originalValidity": 0,
    "validity": 0,
    "checkedAt": "ISO8601时间",
    "stale": false,
    "reasonCode": "original_invalid"
  }
}
```

前端将 completed/unavailable 都作为终态停止轮询；HTTP 200 不等于一定有链接，必须按 status 分支。其他网盘原样交付示例为 completed + delivery=original + validity=-1 + reasonCode=unsupported_provider，含该条原 URL/密码。

### 3.4 查询有效性

`POST /api/links/status`（批量只读，最多 50 个引用）：

```json
{"items":[{"resultRef":"...","linkRef":"..."}]}
```

返回每项 `linkRef,type,validity,checkedAt,lastAttemptAt,stale,reasonCode`，不返回 URL、提取码、内部账号信息。无权/过期等用每项 `errorCode` 区分，不能标成失效。

`POST /api/resources/status`（最多 50 个 `resultRef`）返回授权视角的资源汇总状态及检查时间。两接口只查已保存状态，不因轮询触发新转存或无限上游检测；新鲜检测由采集入队、后台调度和 resolve 工作流完成。本期无用户“任意 URL 强制刷新”入口。

## 4. 获取链接的处理流程

1. 验证引用和权限，解析服务端保存的原链接及密码。无可返回 URL 的项目数据错误返回 422，不能伪造链接。
2. 非百度/夸克直接返回原链接，默认有效性 `-1`，原因 `unsupported_provider`；不发送上游检测请求。
3. 百度/夸克先按原分享身份及密码指纹、目标账号和目录查自产映射并核验自产分享。可用且未临期则返回它，独立于原分享有效性；策略修订不延长既有截止时间。
4. 没有可用自产分享才核验原分享；明确失效/资源不存在标 0，接口、密码、登录、网络或限频错误标 -1 并回退原链接。
5. 原分享可访问且转存开关启用时，转存到专用子目录；确认目标文件 ID，再创建分享。必须是该输入精确对应的文件集合，不按标题猜测已有文件，不能分享整个目标根目录。
6. 返回新分享 URL 和它自己的提取码，同时返回应用截止时间和平台真实有效期。保存映射及阶段状态。
7. 除明确原分享失效/资源不存在外，失败回退这条分享的原 URL 和原密码。已有可用自产分享不会被原分享失效状态覆盖。新分享密码不能配原 URL，反之亦然。不隐式改选同资源的另一网盘链接。

### 幂等、并发与不确定结果

- 同一 Session + requestKey + 参数绑定，重试同一 key 重放已有结果；同 key 换参数返回 409。即便首次响应丢失，也只能查原 key，不能自动新建写操作。
- 不同用户请求同一输入时，按 `(link,inputVersion,targetAccount,targetDir)` 复用精确产物映射；策略修订不迫使重复转存。每个调用者独立授权和持有操作记录；跨用户不共享原响应/Session。
- 管理员写接口与新公开写流程使用同一 provider/account advisory lock 规则；排队占用计入总预算。账号全局写并发默认 1，检测并发默认每 provider 2。
- 网盘已接收写操作但响应超时/进程崩溃，记 `uncertain`，对用户返回原链接。不得自动重新转存；下次先只读核实任务/目标文件，再恢复分享步骤。
- 转存成功、分享失败：保留目标文件映射，后续只尝试分享，不重复转存；不自动删除已保存文件作“回滚”。
- 总预算届满后不再发起新写请求。已在途写请求无法撤回，必须保留其阶段证据并协调只读核实，不能因协程取消就当成没发生。
- 账号凭据变化使旧在途写任务停止；复用键必须绑定经核实的账号身份和配置版本。仅刷新 Cookie 不代表更换账号，但无法核实一致时保守停用旧映射。
- provider 故障/限频时使用退避与熔断；不重复获取新账号或绕过平台限制。最终回退仍要经过权限校验。
- 幂等结果重放必须重新检查产物回收状态和截止时间，不能原样返回已删除的自产分享。已失效产物将原请求终态响应更新为“安全回退原链接”或“原链接失效不含 URL”，不通过旧 requestKey 重新发起写操作。

### 到期撤销分享与文件清理

1. 百度/夸克项目专用目录下，为每个产物分配独立子目录；记录真实目录 ID、父目录、账号身份、创建工作流和文件 ID。保留期从首次创建该目录/开始转存计时，即便分享失败或操作中断，部分文件也会进入回收范围。
2. 平台分享期限尽量与应用期限匹配。产物进入 `expiring/cleaning` 后，不再被缓存命中或生成新分享。取链和清理共用产物租约以及 provider/account 写锁，避免返回后立刻删除的竞态。
3. 临近到期的禁交付窗口 `deliveryMinRemainingSeconds` 可配置，且必须小于保留期。默认建议 5 分钟，具体值和保留期一起配置。重建时使用新 generation/子目录，不复用正在清理的文件。
4. 清理 worker 先撤销产物关联的所有自产分享，再清理本工作流拥有的文件/目录。撤销失败（分享明确不存在除外）先记录退避重试，不扩大删除范围。
5. 删除前重查目标账号、父子目录关系、所有权与文件快照。不能删除运营者原有文件、同名文件、原始外部分享或整个项目目录。任何身份不确定项转人工核实，任务进入 blocked，不伪报释放容量。
6. 公开交付默认只复用本系统仍在保留期内的产物，不跨目录复用运营者原有文件；若未来引入共享文件复用，必须增加引用计数并在全部有效分享引用结束后删除。本期不依赖 provider 的同名去重来判定文件可删除。
7. 目录中发现非本任务文件/人工改动，不能递归清空目录；只删除已核实归属的文件，剩余内容留存并报告。来源本身含目录时，应保留转存所得目录树标识/快照；无法核实后续新增内容则阻止递归删除。
8. 分享/文件“已不存在”按幂等成功处理；Cookie 失效、网络超时、换号、限频属于失败/不确定，保留记录并重试只读核实。持久化逐阶段进度，崩溃后不会重复扩大删除范围。
9. 平台可能把删除文件放入回收站。回收站是否继续占用空间需分别确认；本期不清空整个账号回收站。若正常删除不能释放配额，应在文档/管理诊断中说明实际结果，后续仅考虑本任务文件的精确永久删除能力。
10. 修改保留时长默认只作用于新产物；旧产物继续使用已保存的截止时间。自动清理任务按期运行，遇到限频/凭据问题到期并不等于已经删除，需可观察延迟和失败数量。

当前管理员 `delete-preview/delete` 是交互确认流程，不能作为后台清理绕过确认的入口。新增内部“撤销分享”和“按已核实产物 ID 删除”能力，授权来自已配置的交付保留策略和持久化产物归属；管理员原接口继续保留原权限及确认要求。

## 5. 有效性规则与检测调度

### 数值语义

| 值 | 含义 | 典型依据 |
| --- | --- | --- |
| -1 | 未检测，或暂时无法判定 | 未入队、不支持的平台、首次检测超时/登录失效/提取码错误 |
| 0 | 明确失效 | 平台明确分享取消、资源删除或不存在 |
| 1 | 有效 | 当前提取码下实际可访问目标分享内容 |

仅三个值无法区分“从未检测”和“检测未能完成”，因此增加时间、错误原因和 `stale`。检测接口异常将当前 `validity` 覆盖为 -1、清空 `valid_until` 并更新尝试时间/退避/错误；旧明确检测时间仅供诊断，不继续沿用旧 0/1。明确分享取消或不存在标 0；完整解析成功但文件列表为空时按 `resource_missing` 标 0。自产分享的检测状态独立，不被原分享的异常覆盖。

资源汇总只针对当前可见且版本匹配的链接：任一 1 → 1；非空且全部 0 → 0；其他 → -1。无链接也为 -1。用户看不到的 occurrence 链接不得参与其汇总；后台资源表可维护全局汇总，公开响应必须按授权集合重算。

### 推荐调度

- 采集/手工编辑成功落库后，在同一事务写待检测任务（去重）；网络检测不放在采集事务内。
- 用户请求优先，其次新资源，最后到期复检；调度需有老任务防饥饿机制。
- 建议初值：有效 24 小时复检，明确失效 7 天复检；瞬时错误退避 5 分钟→30 分钟→2 小时→6 小时并加随机抖动。这些为可配置起点，不是保证每天扫完整库。
- 每个 provider 配置原链检测间隔/每日预算，至少保留 20% 给点击请求；预算耗尽保留队列并退避，展示真实检测时间。
- 历史链接分批回填与入队。约 8.8 万条现有 resource_links 不能一次启动全量联网扫描；按平台和规范化身份去重后检测。
- unsupported 平台保持 -1，不反复进检测队列；未来新增 provider 再启用。
- 任务使用持久化租约、`FOR UPDATE SKIP LOCKED`、重试时间及租约 token；网络调用放到事务之外。过期只读检测任务可重试，过期云端写任务不可按同样方式盲重试。
- 原 URL/提取码改变时输入版本递增，作废旧检测和自产分享映射；旧任务完成只按原版本条件更新，不能覆盖新状态。
- 默认 `serve` 内嵌 TG 与链接服务；独立部署可关闭内嵌后运行 `worker`/`link-worker`。本地关联自动运行、巡检受独立开关控制、清理默认运行且可应急暂停；不设定时批量转存。

## 6. 数据库字段设计

拟新增 migration `011_link_resolution.sql`（实施时确认编号）。历史 001–010 不修改，不通过改校验值跳过真实迁移差异；当前库曾调整 001/002 校验记录，实施前需用干净库执行现有 migrations 后对比真实 schema，而非只查看迁移记录。

### 6.1 `managed_resources` 增加字段

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| `link_validity` | SMALLINT NOT NULL DEFAULT -1，CHECK IN(-1,0,1) | 后台全局汇总，满足资源级状态字段要求 |
| `link_validity_updated_at` | TIMESTAMPTZ NULL | 最近汇总时间 |
| `links_revision` | BIGINT NOT NULL DEFAULT 1 | 可交付链接及密码变更版本 |

保留旧 `check_status/check_message/checked_at` 兼容原管理员接口，但所有写入统一经过新链接检测服务；资源旧文本状态仅作为旧历史信息，不能据它把每一条链接初始化为 valid。资源/occurrence 变更需同步或标记汇总过期，聚合更新时间不冒充每条链接的检测时间。

避免检测每条链接就触发 `managed_resource_revision` 全局搜索缓存失效：状态按批次汇总且只在值变化时更新；搜索结构缓存与状态查询分开，投影时批量补充状态。实施时审查现有 statement trigger，即使 UPDATE 零行也可能触发。

### 6.2 新表 `link_catalog`：原分享的统一状态目录

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 内部链接 ID，不作为公开授权依据 |
| `provider` | TEXT NOT NULL | cloud type，包括未支持的平台 |
| `identity` | TEXT NOT NULL | 服务端规范化原分享身份 |
| `original_url` | TEXT NOT NULL | 原始可打开链接 |
| `original_password` | TEXT NULL | 原提取码，敏感字段 |
| `input_fingerprint` | TEXT NOT NULL UNIQUE | provider + identity + 密码 + 规范化版本的服务端指纹；不对外返回 |
| `input_version` | BIGINT NOT NULL DEFAULT 1 | 工作流绑定的输入版本 |
| `validity` | SMALLINT NOT NULL DEFAULT -1，CHECK IN(-1,0,1) | 最近确定结论 |
| `checked_at` / `valid_until` | TIMESTAMPTZ NULL | 确定结论时间 / 新鲜度期限 |
| `last_attempt_at` / `next_check_at` | TIMESTAMPTZ NULL | 上次尝试 / 下次检测时间 |
| `last_error_code` | TEXT NULL | 脱敏原因；不存完整上游响应 |
| `failure_count` | INTEGER NOT NULL DEFAULT 0 | 连续暂时性失败数，CHECK >=0 |
| `last_seen_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | 搜索/采集发现时间 |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | 审计时间 |

同分享不同密码允许不同记录，防止错误密码的 unknown 污染正确密码结果。展示层去重忽略密码，检测/交付层不能忽略密码。密码变更创建新 fingerprint 记录并重绑资源关联；同一 catalog 输入不可静默原地改给已有任务。

`(provider,next_check_at,id)` 建可调度索引。不用明文 Cookie 或凭据哈希作为公开键。原链接权限在结果/资源关联层控制，catalog 记录存在本身不代表用户可读。

### 6.3 新表 `resource_link_bindings`：资源展示版本与链接关联

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `resource_id` | TEXT NOT NULL FK managed_resources ON DELETE CASCADE | 持久资源 |
| `scope_key` | TEXT NOT NULL | `managed` 或由服务端编码的 occurrence 定位 |
| `link_key` | TEXT NOT NULL | 展示内稳定链接身份，不能采用可变数组下标 |
| `link_id` | UUID NOT NULL FK link_catalog | 对应原分享 |
| `links_revision` | BIGINT NOT NULL | 关联时的资源/occurrence 版本 |
| `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | 更新时间 |

主键 `(resource_id,scope_key,link_key)`，索引 `(link_id,resource_id)`。`scope_key` 的来源必须受服务端校验；occurrence 删除/变化时在同一事务删除/替换关联。实时结果不要求插入 managed_resources，其引用存在 Redis；首次交付或后台登记时按 fingerprint 幂等建 catalog。

采用新关联表是为避免更改当前 TG 采集的 resource_links 主键和语义。所有写入口必须汇总到同一个同步函数，不让 links_json、occurrence 和 catalog 各自更新。搜索只批量读状态，未登记实时链接显示 -1；登记失败不可退回明文 URL。

### 6.4 新表 `link_share_cache`：转存目标与自产分享

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 交付产物 ID |
| `link_id` / `input_version` | UUID FK link_catalog / BIGINT | 原分享版本 |
| `target_account_key` | TEXT NOT NULL | 服务端核实的目标账号标识 |
| `account_revision` / `policy_revision` | BIGINT NOT NULL | 账号/目录/分享策略变更隔离 |
| `target_dir` | TEXT NOT NULL | 百度路径 / 夸克 fid |
| `state` | TEXT NOT NULL | saving/saved/sharing/ready/invalid/uncertain/failed/expiring/cleaning/deleted |
| `generation` | INTEGER NOT NULL DEFAULT 1，CHECK >0 | 到期后按需重建产物的代次 |
| `owned_dir_id` / `owned_dir_path` | TEXT NULL | 本工作流专用子目录真实 ID/路径 |
| `ownership_manifest_json` | JSONB NOT NULL DEFAULT '{}' | 账号、父目录、创建与文件树归属证据 |
| `upstream_share_ids_json` | JSONB NOT NULL DEFAULT '[]' | 本产物创建的所有分享 ID，供逐项撤销 |
| `retention_seconds` | INTEGER NOT NULL，CHECK >0 | 创建时的保留策略快照 |
| `cleanup_after` | TIMESTAMPTZ NOT NULL | 应用到期/清理时间，缓存命中不得延长 |
| `deleted_at` | TIMESTAMPTZ NULL | 已核实完成清理时间 |
| `target_files_json` | JSONB NOT NULL DEFAULT '[]' | 本人网盘真实文件 ID、类型和核实证据 |
| `upstream_task_id` | TEXT NULL | 网盘写任务追踪 |
| `share_url` / `share_password` | TEXT NULL | 自产分享 URL/密码 |
| `share_validity` | SMALLINT NOT NULL DEFAULT -1，CHECK IN(-1,0,1) | 自产分享独立检测状态 |
| `share_checked_at` / `share_valid_until` / `share_expires_at` | TIMESTAMPTZ NULL | 检查、新鲜度、平台到期时间 |
| `lease_token` / `lease_until` | UUID NULL / TIMESTAMPTZ NULL | 跨进程工作流租约 |
| `last_error_code` | TEXT NULL | 脱敏失败原因 |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | 时间 |

唯一键 `(link_id,input_version,target_account_key,account_revision,target_dir,policy_revision,generation)`，另对可交付/构建中状态建立不含 generation 的活动唯一索引，排除 expiring/cleaning/deleted。uncertain 仍占活动键，先核实再开放新 generation，不能借代次重复转存。ready 要求 share_url 非空。索引 `(cleanup_after,id)` 支持到期扫描；清理后保留墓碑及幂等记录，不立即删除映射行。云端删除管理员接口成功后同步失效映射；无法准确映射时让同账号相关缓存进入待复核。

### 6.5 新表 `link_resolve_requests`：调用幂等与最终响应

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `id` | UUID PK | 内部操作 ID |
| `request_key` | UUID NOT NULL | 客户端幂等键 |
| `subject_key` | TEXT NOT NULL | Session HMAC 摘要，不存明文 token |
| `user_id` | BIGINT NULL FK users ON DELETE SET NULL | 已登录用户，可匿名 |
| `request_fingerprint` | TEXT NOT NULL | 引用/输入版本/策略绑定 |
| `link_id` / `share_cache_id` | UUID NOT NULL FK link_catalog / UUID NULL FK link_share_cache | 工作对象 |
| `authorization_json` | JSONB NOT NULL | 搜索范围/来源/持久资源定位，供轮询重查权限 |
| `status` | TEXT NOT NULL | queued/running/completed/failed |
| `delivery` / `reason_code` | TEXT NULL | 原链接回退与自产分享区分 |
| `result_kind` | TEXT NULL | available/unavailable，区分业务完成但原链接已失效 |
| `response_json` | JSONB NULL | 最终可重放响应，敏感；不存 Cookie/上游令牌 |
| `deadline_at` | TIMESTAMPTZ NOT NULL | 工作流总期限 |
| `created_at` / `updated_at` / `completed_at` | TIMESTAMPTZ | 生命周期 |
| `expires_at` | TIMESTAMPTZ NOT NULL | 建议幂等记录保留 7 天 |

唯一键 `(subject_key,request_key)`；索引 `(status,deadline_at)`、`expires_at`。网盘 uncertain 保存在 share_cache，已安全回退的公开请求可 completed，不能将“业务回退完成”误解成“云端写入确认失败”。过期请求返回 410，不能自动复用旧 key 创建任务。要保留过期 key 的短期墓碑或要求客户端更换 key；share_cache 的永久幂等屏障仍需存在。

### 6.6 新表 `link_check_jobs`：检测队列

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `id` | BIGSERIAL PK | 任务 ID |
| `link_id` / `input_version` | UUID NOT NULL FK link_catalog / BIGINT | 检测对象版本 |
| `kind` | TEXT NOT NULL | original/reshared |
| `share_cache_id` | UUID NULL FK link_share_cache | 检测自产分享时必填 |
| `status` | TEXT NOT NULL | queued/running/completed/failed |
| `priority` / `attempts` | INTEGER NOT NULL DEFAULT 0 | 优先级 / 次数 |
| `run_after` | TIMESTAMPTZ NOT NULL | 可执行时间 |
| `lease_token` / `lease_until` | UUID NULL / TIMESTAMPTZ NULL | 租约及超时恢复 |
| `last_error_code` | TEXT NULL | 脱敏错误 |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | 时间 |

CHECK 校验 kind 与 share_cache_id 的组合；original 按 `(link_id,input_version)`、reshared 按 `(share_cache_id,input_version)` 建各自的活动任务部分唯一索引（status IN queued/running），避免 NULL 唯一键漏去重；就绪索引 `(run_after,priority,id)`。历史完成任务按配置归档/清理，不删除业务资源或云端文件。

### 6.7 新表 `link_cleanup_jobs`：自产分享/资源清理

| 字段 | 类型 / 约束 | 用途 |
| --- | --- | --- |
| `id` | BIGSERIAL PK | 任务 ID |
| `share_cache_id` | UUID NOT NULL FK link_share_cache | 唯一交付产物，不能由客户端提交任意文件 ID |
| `status` | TEXT NOT NULL | queued/running/completed/failed/blocked |
| `stage` | TEXT NOT NULL | verify/revoke_shares/delete_files/verify_deleted |
| `progress_json` | JSONB NOT NULL DEFAULT '{}' | 已撤销分享、已删文件和待核实项 |
| `run_after` | TIMESTAMPTZ NOT NULL | 截止或退避时间 |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | 尝试次数 |
| `lease_token` / `lease_until` | UUID NULL / TIMESTAMPTZ NULL | 租约 |
| `last_error_code` | TEXT NULL | 脱敏失败原因 |
| `created_at` / `updated_at` / `completed_at` | TIMESTAMPTZ | 时间 |

同 share_cache_id 的 queued/running/blocked 建部分唯一索引，失败重试更新原任务；清理失败需限次退避再 blocked，不能静默丢失。创建云端产物前先在数据库登记清理任务，避免 API 崩溃留下无人管理的文件。link-worker 分配独立检测与清理并发预算。

### 6.8 配置

优先扩展 `policy_settings` 的 `link-delivery` / `link-check` JSON 配置，并做强类型校验和版本控制。Cookie 继续放在 `cloud_account_settings`，不新增重复凭据表。账号真实身份与 revision 存在服务端配置中，现有 Cookie 保存入口必须核实/更新它；不能依赖管理员手工增加 revision。

每 provider 的配置：`enabled,targetDir,accountRevision,policyRevision,shareReuseEnabled,deliveryTtlSeconds,platformShareTtl,deliveryMinRemainingSeconds,cleanupScanSeconds,cleanupConcurrency,checkConcurrency,writeConcurrency,qps,dailyCheckBudget`；全局配置：引用 TTL、HTTP 等待时间、总工作流预算、复检周期、请求限流、任务保留期。已有 settings 接口若公开返回配置，必须排除内部目录/账号信息。

目标目录或保留时间未配置时回退原链接并给出配置原因。创建专用目录、撤销分享能力当前未在统一 Drive 中暴露，本期需补齐两个 provider 的相关方法。项目父目录可以由管理员配置，产物子目录由服务端创建；不得悄悄用根目录替代配置错误。

配置界面以“小时/天”输入保留时间，服务端统一存秒；未填写时 `enabled=false, deliveryTtlSeconds=null`，保存启用配置必须校验正数、临期窗口小于保留期及目标目录合法。分享永久参数不等于应用永久保留：即使平台只支持较粗粒度，应用到期仍会安排撤销和文件清理。具体时长由运营者在配置页选择，不阻塞本期接口和任务开发。

## 7. Web 与小程序改造

### Web

- `frontend/shared/apiModels.ts` 拆分公开 `SearchLink`、内部/管理员 `Link`、`ResolvedLink`，避免管理员页面丢失链接编辑能力。
- `resultMerge.ts` 用完整 `dedupKey` 合并；`resultDisplay.ts`、卡片 key 使用 resultRef/linkKey，保持同资源多链接分别展示。
- `ResultGroup.vue` 始终显示网盘类型、“打开链接”和“复制链接”两个按钮；不显示标签、未检测/待确认、交付来源或保留期限文案。任一按钮点击都使用相同 resolve/轮询流程，完成后分别跳转或复制返回 URL 与对应提取码。
- 一次点击只启动一个流程；同条链接多次点击共享 in-flight Promise。403/410 清理缓存，要求重新登录/搜索；页面退出停止轮询，不重新触发云端写操作。
- 打开动作在点击时预留新页，取链成功后跳转，失败则关闭；复制在点击时预留剪贴板操作。仅获取中同时禁用；本次确认失效时提示原因，不跳转、不复制，但不根据历史原链状态阻止下次点击。每次新点击重新判断自产分享，未结束请求保留原幂等键。
- `AdminResourcesPage.vue` 移除截图中工具总入口、检测/转存/删云端按钮及抽屉挂载、批量云端动作；保留资源本地删除，避免误删功能边界。`CloudDriveWorkbench` 如无其他引用可移除 UI 文件，后台 handler/provider/测试保留。
- 系统配置页继续管理账号与新增交付策略；资源页显示只读状态和最后检测时间。

### 小程序

- 接入相同 v2 搜索 DTO，用 `Authorization: Bearer <session>`；沿用现有登录会话模型。
- 始终显示打开/复制两按钮，共用 resolve/轮询流程；请求超时后查原 requestKey，不重发写请求。仅取链期间共同禁用；确认失效时弹窗提示但允许后续重试，不以历史原链状态拦截自产分享。
- 打开动作通过 `pages/link/index` 的 web-view 跳转；复制动作写入剪贴板。外部跳转按微信合法域名及平台能力实现，不承诺任意网盘 URL 都能直开，不支持时明确提示使用复制按钮，不能将打开暗中替换成复制。
- 列表按 linkKey 更新状态，onHide/onUnload 停止轮询，返回页面可继续查同一任务；未获取的 URL 不进入页面数据或本地存储。
- 已复制 `main@9a2d310` 的 58 个文件；复制不等于完成协议改造。对应修改点：`utils/api.js` 增加 resolve/status，`utils/auth.js` 保留 202 与 requestKey、不盲重试写操作，`utils/searchStream.js` 接新 DTO，`utils/resultMerge.js` 改身份与合并规则，`pages/index/index.js` 改 view-model，`components/resource-card/index.js/.wxml` 改取链/状态/复制。
- 当前 main 小程序仍使用“共享任意链接即合并”的并查集，与 rust Web 的“完全相同分享集合才合并”不同；本期必须统一使用服务端 dedupKey，防止合集桥接误合并。
- 当前小程序注释和代码仍假定无 Session 可搜索，而 Rust 要求有效 Session。微信登录失败后的匿名兜底需调用 `GET /api/account/session`，读取响应 `sessionId` 并保存为 Bearer token；这一路径受现有会话创建限流保护。该接口未返回 expiresAt，小程序遇失效后重新建会话并重新搜索获取引用，不能把新 Session 用于旧 resolve 请求。普通只读接口的自动重登重试与云端写接口分开处理。
- 当前 `utils/config.js` 指向远程站点，复制后尚未切换本机后端，也未运行联网调试。后续本地配置使用开发者工具可达地址/开发 HTTPS；真机不能使用 Mac 的 127.0.0.1。
- 小程序已有单测命令 `node miniprogram/scripts/test-utils.js`；扩展至 v2 协议及生命周期测试，再在微信开发者工具验证。

## 8. 实施顺序与验收

1. 根据已确认规则补齐部署保留时间，完成旧库真实 schema 与干净 migrations 结果对比；备份当前数据库。
2. 新增 011、强类型状态与内部交付服务；分批从 managed_resources.links_json 和 occurrence.result_json 建关联，保留所有原链接；历史状态默认 -1。
3. 将原管理员检测接口改为写新状态服务，同时维持现有响应兼容；原转存/删除接口继续管理员专用。
4. 开发 resolve、轮询、批量链接/资源状态接口及独立 link-worker；补目录创建、撤销分享和到期清理，使用模拟 provider 测试失败矩阵和持久幂等。
5. 改造 Web、小程序；先部署新能力但不切换公开搜索协议，两端准备好后协调切换 v2，并隔离旧缓存。不能在客户端未准备好时提前删搜索 links.url。
6. 启动低速后台检测，观察吞吐、队列积压、限频和失败比例，再调整预算。不开启全量自动转存。

必须覆盖的验收场景：

- 搜索所有 SSE 事件、JSON 顶层/嵌套结果、文本与缓存均无分享 URL/提取码泄漏。
- 同资源百度/夸克多链接独立取链；重复集合合并不产生合集吸收单资源问题。
- 其他网盘、磁力等只返原链接；不被误判有效，不发百度/夸克请求；前端限制可导航协议，恶意脚本 URL 不能执行。
- 百度/夸克完整成功只返回目标账号自产分享和相应密码；不是原分享文件 ID。
- 原分享明确失效、错误密码、登录过期、配额满、目标目录错误、限频、超时、部分转存、分享失败分别验证回退和状态。
- 响应丢失、客户端双击、两个用户并发、服务重启、过期租约不造成重复转存；uncertain 必须先核实。
- 临近到期禁止交付、缓存命中不续期、到期停止复用、撤销后精确删自己产物、部分失败可恢复、未知文件不删、换号阻止删除、回收站空间语义可验证；定时清理不误删父目录/运营者旧文件。
- 轮询重放不能返回过期/已清理自产链接；原链接明确失效响应中没有 URL 或密码。
- Session 冒用、引用跨会话、资源下架、频道授权变化、链接/密码变化、换账号均不能返回旧授权链接。
- 状态 1/0/-1 聚合、unsupported、空链接、过期结论、部分可见 occurrence 不互相污染；原分享和自产分享状态独立。
- 旧库字段/业务数据保留，新增字段回填可续跑；仅新增 migration，不修改历史校验记录。
- 网站构建、类型检查、前后端单测与隔离数据库集成测试通过；小程序独立验证，不以 Web 测试代替。

测试命令沿用 `cargo test`、`npm run typecheck`、`npm test`、`npm run build`。涉及 PostgreSQL/Redis 的测试使用隔离测试库。实盘验收只使用专门测试分享/目录，在确定目标后执行，不使用生产资源作自动删除测试。

## 9. 本次设计不涉及

积分/兑换；公开云端删除入口；清理本工作流之外的运营者文件或整个回收站；额外网盘转存 provider；重新采集历史数据；把资源失效等同于删除/下架资源。后续积分可加在统一 resolve 授权入口，本次不预建积分表或扣减逻辑。

## 10. 开发交付核验

- 已新增迁移 011 与公开取链/轮询/状态接口；后台旧云盘接口继续保留。
- 搜索 SSE、JSON 顶层和嵌套结果统一隐藏 URL/提取码；网站和小程序均按需取链。
- 管理后台资源列表云端操作入口已移除，系统设置增加按需交付、期限和后台检测配置。
- 独立 `link-worker` 处理历史链接关联回填、定时原链接检测、状态汇总、到期撤销与安全删除；配置默认关闭自动转存和后台检测。
- 测试结果、运行命令、数据库备份位置和实盘验收边界详见 [开发交付与运行说明](link-resolution-implementation.md)。设计中的真实账号身份核验等增强项采用保守降级策略，不应把本地模拟测试视为真实网盘实盘验收。
