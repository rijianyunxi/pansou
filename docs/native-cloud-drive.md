# 百度 / 夸克网盘原生接入

实施日期：2026-09-30。参考 wangpan 分支 482a4b2 的 provider 与工具流程；实现位于 Rust 分支，不运行原分支的 Node 服务/脚本。

## 后台入口

- 「网盘资源 → 网盘工具」：输入百度/夸克链接、提取码、目标目录，检测、检测已有、转存、云端删除。每条受支持链接旁「检测 / 转存」自动带入链接。
- 原「删云端」现在先做服务器归属预检，再展示真实待删条目并确认，不再返回 deletedCount=0 的假成功。
- 「系统设置 → 云端操作」继续保存 Cookie。GET 只返回 configured / cookieLength；空字符串不修改，null 明确清除。百度检查 BDUSS/BDUSS_BFESS 与 BAIDUID。
- 百度目录是绝对路径，默认 /；夸克目录是 fid，默认 0，不能填写文件夹名称代替 fid。
- 首页搜索界面不改，工具不接入公开搜索，全部接口仅管理员可用。

## 功能与修正

1. 严格校验实际域名、分享 ID，支持 URL 内 pwd/passcode 和显式提取码；完整分页，不能把截断列表当完整结果。
2. 原生转存：百度 Cookie、bdstoken、sekey、表单协议；夸克分享/文件令牌、同步任务结果和有界异步轮询。复用分享上下文，不重复解析。
3. 去重仅复用唯一匹配文件。夸克比较名称/大小，百度优先 MD5；已知不同 MD5 不能因同名同大小复用。目录不按名称或零大小复用，防止遗漏目录内容。
4. 原分支任意命中就返回 reused，会忽略 missing。本实现只转存缺失项，matched + 新文件一起生成分享。
5. 新分享不能使用原分享的文件 ID。自动分享对目标目录前后快照/任务 ID 做唯一确认，不做文件名前缀猜测。无法确认时返回已转存结果与 shareError，不再次转存。
6. 百度比对分享者 uk 和登录账号 uk；夸克通过当前账号个人分享列表核实链接。非本人分享、文件列表变化、Cookie 变更、确认过期都拒绝删除。
7. 删除目录包含其全部内容，预检明确提醒。云端删除不删除盘搜记录或 links_json；本地记录清理使用普通资源删除。
8. 错误提取码、登录失效、超时、限频、未支持的网盘为 unknown，不能直接标 invalid。仅明确失效码为 invalid；多链接至少一条 valid 即 valid，全部明确 invalid 才标 invalid。

## 模块与安全

- src/cloud_drive/mod.rs：统一模型、链接解析、去重/转存编排。
- src/cloud_drive/transport.rs：专用 reqwest 连接池、20 秒请求/响应体超时、8MiB 限制、Cookie 更新、脱敏错误。
- src/cloud_drive/baidu.rs / quark.rs：原生分页、转存、分享、账号归属和删除。
- src/handlers/cloud_drive.rs：管理员入口、批量检测、确认票据、持久化幂等和状态查询。
- migrations/010_native_cloud_drive.sql：新增操作/删除确认表，不改写原业务数据。
- frontend/components/admin/CloudDriveWorkbench.vue：共享 shadcn 抽屉、独立滚动字段、固定动作区、内联结果/错误。
- frontend/composables/admin/useCloudDrive.ts、lib/cloudDriveOperations.ts：写请求只 POST 一次，202 或响应丢失后只查询编号。

上游为服务端固定 HTTPS 域名，不直接请求用户传入 URL，不把 Cookie 发给来源转发节点，不跟随重定向。替换上游仅存在于 cfg(test) 构建。每条链接用独立临时 Cookie jar，避免百度 BDCLND 并发串分享。每进程最多 4 个工作流；写操作使用 PostgreSQL 事务 advisory lock 按 provider 跨进程互斥，取得锁后再次核对凭据指纹，拒绝排队期间账号发生变化的操作。夸克归属校验使用已实测的 share/mypage/detail 我的分享列表，并要求 is_owner。

## 接口契约

下面均在 /api/admin/cloud-drive 下，正常响应保留 code / message / data 信封。

| 方法 / 路径 | 请求 | 行为 |
| --- | --- | --- |
| POST /check | url, provider?, password? 或 resourceId + linkIndex | valid / invalid / unknown、安全文件信息，不返回内部令牌 |
| POST /list | provider, dir? | 当前账号目录 |
| POST /ping | provider | 只读登录态检查 |
| POST /save | url, password?, toDir?, dedup?, autoShare?, requestKey | 默认 autoShare=true、dedup=false |
| POST /existing | url, password?, toDir?, autoShare?, requestKey? | 默认只读；显式 autoShare=true 必须带 requestKey |
| POST /delete-preview | url + password? 或 resourceId + linkIndex | 归属核验、完整文件列表、count、confirmationToken，5 分钟有效 |
| POST /delete | 预检目标 + confirmationToken + requestKey | 重查归属及快照，确认只消费一次，真实删除 |
| GET /operations/{requestKey} | UUID | 只查询当前管理员自己的操作，处理中 202，结束返回原结果 |

原 /api/admin/resources/check 已实现真实检测，保存 check_status / check_message / checked_at，防止覆盖链接已变化的结果。批量最多 50 个资源，每资源最多检测 20 条链接，并行 4、总截止 90 秒。

原 /api/admin/resources/cloud-delete 保留入口，现在必须附 confirmationToken 与 requestKey，返回实际 provider / deletedCount，前端已同步。

### 幂等与确认

requestKey 为 UUID。同管理员、动作、凭据、参数重复同一 key 只返回存储结果；更改参数复用 key 返回 409。流程在 API 后台 task 运行，浏览器断开不自动取消/重放；25 秒未完成返回 202，通过编号查询。

状态 running / completed / failed / uncertain。写请求发出后的网络/任务失败保守记录 uncertain，同一 key 不能再次执行；服务中断后过期 running 也转 uncertain。先核对云端，不可因报错就新建重复操作。「开启新操作」显式提醒核对旧状态，不隐式重置编号。

删除票据绑定管理员、Cookie 指纹、规范化分享链接/提取码及文件快照。操作记录保留作幂等依据，不随重启清空。数据库/备份含敏感账号和分享信息，限制访问，不能提交 Git。

## 升级与测试

备份 PostgreSQL、停止旧 API / worker，新 API 应用 010，核对原数据及断点后恢复 worker。不清空资源库或 Redis。

~~~powershell
cargo fmt --check
cargo test
# 配置独立 _test 数据库和 Redis，严禁业务库
cargo test -- --include-ignored --test-threads=1
cd frontend
npm run typecheck
npm test
npm run build
~~~

完整测试：57 项 Rust（包含 3 项隔离集成测试）、47 项前端测试。覆盖真实 HTTP 模拟上游、提取码/Cookie 更新、域名拒绝、分页、同步/异步任务、部分去重、64 位百度 ID、十六进制夸克 fid、归属/确认快照、检测落库、并发/持久化幂等、错误状态、重定向、响应体超时及前端响应丢失不重复 POST。

真实 010 升级前后：108,892 条消息、57,928 条资源、103,688 条关联的数量/内容摘要及采集断点一致。百度/夸克现有账号只读登录态和真实分享检测成功；夸克自己的分享删除预检成功，有效的外部分享被 403 拒绝，未发送删除请求。真实转存/删除未作破坏性测试，写流程用隔离库和本地模拟上游验证，不宣称实盘删除成功。
