# 迅雷实验扫码接入：实现与运行说明

> 更新：2026-10-08。已实现后端 Device Code 实验适配和 mock 回归，**尚未完成迅雷真实账号端到端验收，不应作为生产已支持扫码的承诺**。
>
> 需求与公开资料依据见 [需求实现设计](xunlei-qr-login-requirements-design.md)。本文记录当前代码，而非上游稳定 API 保证。

## 1. 当前交付范围

| 项目 | 当前状态 |
| --- | --- |
| 后台能力开关、上下文校验 | 已实现；数据库保存、即时生效，默认关闭，未配置时仍高级导入 |
| 创建设备授权、官方二维码包装、本地 SVG | 已实现；协议基于静态观察，实际兼容性待验收 |
| pending / scanned / slow_down / expired / denied | 已实现；scanned 不因后续 pending 或限流回退 |
| 首次延迟、429/Retry-After、后续间隔 | 已实现；迅雷独立调度，不改变其他网盘节奏 |
| 一次性兑换落盘保护、恢复失败、暂存凭证验证 | 已实现；不承诺上游 exactly-once |
| 身份查询 + 根目录只读访问 + 原子提交 | 复用既有框架，并加强租约有效期校验 |
| 同客户端/设备上下文、历史导入兼容 | 已实现；新扫码凭证不借用驱动默认 client_id |
| Refresh Token维护 | 复用现有刷新，保留 client/device/captcha 字段及令牌轮换逻辑 |
| captcha失效提示 | 已实现固定安全错误和官方验证/高级导入路径 |
| 自动获取/续期captcha、交互验证码、额外SSO换票 | **未实现**；合法协议仍待确认，不进行签名破解或风控绕过 |
| 真实手机扫码、Token audience、实际客户端权限 | **未验证**；必须获账号所有者明确授权后进行 |

因此当前是可用于受控协议验证的实验实现，不是无需任何上下文配置的完整一键扫码。配置高级上下文并不证明其当前有效；必须通过身份与根目录验证才能成为连接成功的账号。

## 2. 后台设置（默认不启用）

入口：**后台 → 网盘账号 → 迅雷 → 更多操作 → 实验扫码设置**。这是业务功能配置，保存在 PostgreSQL，不再使用迅雷扫码环境变量或外部上下文文件。保存立即生效，所有连接同一数据库的 API 和授权 Worker 读取同一份设置，无需重启。

1. 首次使用时，在高级设置输入同一合法官方客户端/设备的完整上下文，按需开启“启用实验扫码”并保存。
2. 已保存的敏感上下文只写不回显；输入框留空保留原配置，填写新对象则完整替换，不能只提交一个字段与旧上下文混用。
3. 仅关闭开关会保留上下文；明确选择“关闭并清除保存的上下文”才清除。保存任何更改都会取消未完成的迅雷扫码会话并清除其临时材料，不断开已连接账号、不删除网盘文件、不停止已有凭证维护。
4. 仍须运行授权 Worker（可以使用 `auth-worker` 模式，且不能禁用 `PANSOU_AUTH_WORKER_ENABLED`）。修改设置无需重启，但关闭整个 Worker 后仍然没有后台授权轮询。

上下文和账号凭证一样保存在数据库中，目前不宣称已加密；请限制数据库访问并保护备份。设置弹窗关闭、页面卸载或管理员锁定后清空输入，不保存到浏览器持久化存储。

以下 JSON **只说明字段，不是可用凭证**；不要原样启用或使用任意客户端标识。必需字段全部来自同一经合法验证的客户端/设备上下文：

```json
{
  "client_id": "REPLACE_WITH_VERIFIED_SAME_CLIENT_ID",
  "device_id": "REPLACE_WITH_VERIFIED_SAME_DEVICE_ID",
  "captcha_token": "REPLACE_WITH_VERIFIED_SAME_CLIENT_CAPTCHA_TOKEN"
}
```

可选字段仅限 `client_secret`、`signature`、`device_sign`、`ui_client_key`。仅当同一流程实际提供且必需时配置，不抄取其他客户端的 secret。不支持 `headers`、自定义 URL、access_token 等任意字段。

校验规则：上下文最大 64 KiB；client/device ID 最大 256 字节，captcha 最大 16384 字节，可选字段最大 4096 字节；字段不得为空或包含空白/控制字符。保存时校验完整上下文，错误使用固定安全消息，不输出输入内容或解析器原始错误。未配置合法上下文不能开启扫码。

这只是实验接入的配置归位，**仍没有自动获取或续期 captcha 的机制，不是完整一键扫码**。captcha 失效后应重新取得合法上下文并在后台保存，或继续使用高级导入；不将旧 captcha 与新客户端身份混用。

### 2.1 数据库与 API

新增迁移 `053_cloud_qr_settings.sql`，不改已发布迁移。`cloud_account_settings` 新增：

- `qr_enabled`：默认 false，仅迅雷支持该实验开关。
- `qr_context`：敏感上下文，最大 65536 字节；不进入设置查询和账号列表响应。
- `qr_revision`：独立设置版本，默认 0；不改变账号 `binding_epoch`、`token_revision` 或已连接凭证。

管理员接口（响应 `no-store` / `private`，PUT 额外检查请求来源）：

- `GET /api/admin/cloud-accounts/xunlei/qr-settings`：仅返回 `enabled`、`configured`、`revision`、`experimental`，包在现有 `data` 响应结构中。
- `PUT /api/admin/cloud-accounts/xunlei/qr-settings`：提交 `enabled`、`expectedRevision`，可选 `context` 对象或 `clearContext: true`。清除必须关闭开关且不得同时提供新上下文；省略 context 保留原值。
- 版本不匹配返回 409，要求重新读取后再保存；不支持其他 provider。更新在账号行锁事务中校验版本、保存设置并取消活跃扫码会话。扫码创建使用同一行锁，后台写入仍受状态与租约保护，防止旧会话迟到结果覆盖新状态。

## 3. 接入和安全边界

- 独立适配器：`src/cloud_auth/providers/xunlei.rs`。仅请求固定认证 origin `https://xluser-ssl.xunlei.com` 的设备码/令牌端点，使用 JSON body；这仍需在真实协议验收中确认。
- 上游请求超时12秒、JSON响应上限1 MiB、不跟随重定向；测试地址重写只在 `cfg(test)` 编译中存在。
- 创建响应必须包含正整数 `expires_in`、`interval`、非空 device_code 和官方 verification_uri_complete。支持的二维码有效期上限3600秒，超出则失败而非猜测。
- 二维码输入限制为HTTPS、精确官方主机、`/device` 或 `/device/` 路径、非空query；拒绝用户名/密码、异常端口、fragment和额外redirect字段。后端包装到官方 qrlogin，并本地生成base64 SVG，不加载官方SDK/CDN。
- 当前只实现Device Code结果直接作为候选Token的路径。若真实客户端需要额外SSO/PKCE/code exchange，本实现会在后续校验失败，不自动改用其他客户端或猜测换票流程。
- 保存凭证标记 `auth_flow=xunlei_device_code_v1`。标记凭证缺少client/device或别名不一致时拒绝；历史导入不变。令牌响应中的不同client/device不允许覆盖原上下文。
- 用户身份由现有官方身份请求核实。缺少 Token/user_id/captcha 或根目录访问失败，不能保存为connected，也不覆盖旧账号。
- 仅管理员且仅会话创建者可查询/取消。展示API不返回device_code、Token、captcha、secret或设备签名；二维码仅在waiting/scanned展示。
- 凭证仍明文存储于PostgreSQL，未新增加密层。保护数据库和备份是部署前置条件。

## 4. 轮询、恢复与取消

1. 首次 `next_poll_at` 至少等待创建响应的interval；浏览器只查询本项目会话，不轮询迅雷。
2. 普通pending按current_interval等待；WAITING_CONSENT使scanned保持，之后的pending不回退。
3. slow_down将间隔提升至 `max(当前+5秒, 初始×2)`；有效Retry-After可使下一次请求更晚。
4. 429采用指数增加的当前间隔（至少10秒），取Retry-After与间隔的较大值，再加入0～3秒非负抖动。间隔不以30秒强制截短。支持秒数和HTTP日期；巨大等待值不会使会话过期后继续轮询。
5. 发送一次性票据前，先在有效数据库租约内把上下文phase写为exchanging。正常pending/限流响应后，原子写回awaiting、调度间隔和下一时间，同时释放租约。
6. 超时、5xx、响应中断、兑换响应无法解析，均不能可靠判断票据是否消费，终止为 `authorization_exchange_uncertain`，要求手动重新扫码。不会盲重试一次性票据。
7. 进程在发送前或返回后、落盘前崩溃，也可能留下exchanging。恢复看到该标记不再请求上游；这是保守失败，不保证每次都能恢复成功。
8. 返回Token后先持久化pending_credential并进入verifying，身份/根目录验证的网络重试重用暂存Token；不会重新兑换。终态清除context及二维码。
9. 取消、过期、替换、租约失效后迟到结果不能写入账号；原有binding_epoch/token_revision及同账号reauthorize检查继续生效。
10. 迅雷身份、根目录和刷新遇到429时保留可读取的Retry-After，延后重试；Token刷新和captcha维护不是同一生命周期。本功能没有提供自动captcha维护。

只有作用于当前会话且租约有效的结果才能落盘。旧请求可能已经到达上游，本地取消不能撤回手机端或上游已执行的授权；只能保证不使用其迟到结果覆盖本地绑定。

## 5. 测试与复现

无需外部服务的mock/单元测试：

```powershell
cargo test --locked
cd frontend
npm run typecheck
npm test
npm run test:build
```

数据库测试必须使用**独立测试数据库**（名称以 `_test` 结尾）及非0的独立Redis逻辑库；不能指向生产。现有CI已配置这类隔离服务：

```powershell
$env:PANSOU_TEST_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/pansou_test'
$env:PANSOU_TEST_REDIS_URL = 'redis://127.0.0.1:6379/15'
cargo test --locked -- --include-ignored --test-threads=1
```

迅雷专项数据库测试为 `cloud_auth::tests::xunlei_qr_scheduling_recovery_and_late_results_are_fenced`，使用本地mock认证和网盘，覆盖首次延迟、scanned保持、长Retry-After、根目录失败不提交、验证重试不兑换、拒绝/过期/不确定响应、重启exchanging恢复、取消/过期/租约失效/会话替换后的迟到成功、双Worker互斥、根目录与刷新限流和创建限频；不向官方请求任何真实会话。

后台设置专项数据库测试为 `cloud_auth::tests::xunlei_qr_settings_are_write_only_versioned_live_and_admin_only`，覆盖未登录/非管理员、跨站写入、错误消息脱敏与禁止缓存、上下文只写不回显、版本冲突、运行中的 Worker 动态启用、关闭取消旧会话、显式清除以及已连接凭证和绑定版本不受影响。

本地测试不等于真实客户端验收。真实验收要另行确认账号使用授权，只读检查，不要求上传/转存/删除文件。

## 6. 后续上线门槛

仍须满足需求文档G1～G3及AC-01～AC-07，特别是：

- 核实真实客户端使用条件、client配置、Token audience/scope和是否需要SSO再次换票。
- 记录实际请求/响应契约、二维码格式、手机平台和客户端版本。
- 确认captcha与设备身份的合法获取及过期处理，验证令牌续期和账号隔离。
- 完成受控真实扫码→身份→根目录只读访问，记录脱敏验收证据。

任何门槛未通过则保持关闭，并保留高级导入。文档和mock不代替真实验收。

## 7. 前一阶段实验适配验证记录（2026-10-08）

环境：Windows、本地临时 PostgreSQL 18（UTF-8、locale C）、专用临时 Redis、本地 mock 上游。测试服务与数据目录独立于用户业务库；没有真实迅雷账号或官方登录请求。

| 检查 | 结果 |
| --- | --- |
| `cargo test --locked` | 153通过、0失败、54项需要服务的测试默认跳过 |
| 授权模块 `--include-ignored --test-threads=1`，使用全新测试库 | 31通过、0失败，包含三个数据库授权测试 |
| 全量 `--include-ignored --test-threads=1`，使用另一个全新测试库 | 200通过、7失败；不能标记为全部通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 152通过 |
| `npm run test:build` | 生产构建和本地运行资源检查通过 |
| 文档链接测试 | 3通过 |
| `cargo fmt --check`、`git diff --check` | 通过 |
| `cargo clippy --locked --all-targets -- -D warnings` | 未通过；35条既有诊断与基线一致 |

为排除本次引入回归，另从 `6dcfbca78fc702e85c5ca5c499cb1a1192a5f0ac` 导出未修改源码，在相同本地环境、另一全新测试库运行：基线全量194项中187通过、7失败；失败名称与本次完全一致。基线严格Clippy也有同样35条诊断，按文件及诊断类型对比一致。此结果只说明在该本地环境可复现，不代表这些既有问题已修复或其他部署环境一定相同。

以下是前一阶段全量测试中基线复现的七个失败；后台设置调整未重复运行这组全量数据库测试：

- `link_resolution::tests::admin_manual_check_targets_only_the_selected_link`
- `link_resolution::tests::public_link_contracts_and_owned_cleanup`
- `link_resolution::tests::resolution_waits_beyond_http_budget_and_fences_expired_results`
- `resource_schema_tests::baseline_resource_triggers_generate_search_terms_and_cascade_deletion`
- `sql_optimization_tests::direct_resource_search_matches_oracle_and_invalidates_only_content_changes`
- `telegram_tests::search_pages_bound_payload_and_preserve_order_scope_and_logs`
- `telegram_tests::telegram_ingestion_search_and_admin_contracts`

原始测试记录保留在被Git忽略的 `.tmp/` 中，不提交服务数据、测试数据库或官方脚本缓存。未执行真实账号联调、业务库迁移、Git提交或推送。

## 8. 后台设置调整验证记录（2026-10-08）

本次设置调整在独立的全新临时 PostgreSQL 测试库（执行迁移 053）、专用 Redis 数据库和本地 mock 上游验证，没有访问真实迅雷账号或迁移用户业务库。

| 检查 | 结果 |
| --- | --- |
| `cargo test --locked` | 154 通过、0 失败、55 项依赖外部服务的测试默认跳过 |
| 授权模块 `--include-ignored --test-threads=1` | 33 通过、0 失败，包含 4 项数据库测试 |
| `npm run typecheck` | 通过 |
| `npm test` | 154 通过、0 失败，包含设置载荷及不再使用迅雷环境变量的回归 |
| `npm run test:build` | 生产构建和本地运行资源检查通过 |
| 文档链接与迁移索引测试 | 3 通过 |
| `cargo fmt --check`、`git diff --check` | 通过 |

本次未重复运行全量数据库测试或严格 Clippy；前一阶段的基线比较见第 7 节，不能把那里的既有失败说成已修复。真实扫码、captcha 自动维护和额外 SSO 换票仍未验收。
