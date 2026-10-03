# 网盘账号管理

后台 → 系统 → **网盘账号**（`/admin/cloud-accounts`）集中管理百度、夸克、阿里、迅雷、光鸭。
卡片上半部分管理授权（扫码连接、高级导入、检查登录态、更换账号、断开连接），下半部分只有两行：`转存` 与 `检测`。`转存` 一行右侧的「配置」按钮打开配置弹窗，设置按需转存开关、项目专用目录、清理时间、平台分享期限，以及检测间隔、每日额度与缓存参数。弹窗底部的「转存」保存并生效，「清除」关闭转存并清空目录与清理时间（不影响已转存的文件和分享，也不改动检测参数）。
后台有效性检测及其他链接 Worker 任务的启停仍统一在「链接任务」控制；保存卡片上的检测参数不会覆盖启停状态。
系统设置不再保留重复的网盘标签或跳转卡片，统一使用侧栏“网盘账号”菜单。
每个网盘的配置保存在 `cloud_provider_policies` 的一行里（转存 + 检测），`link-check` 只保留后台检测总开关。
无需先扫码即可查看已有配置；启用转存与读取目录需要对应账号验证可用。旧凭证不会回显到页面，可通过“检查登录态”验证并迁移。

## 使用步骤

1. 在对应网盘卡片上扫码，用对应官方 App 确认授权。迅雷目前尚未确认扫码协议，使用官方网页登录后的“高级导入”。
2. 服务端验证官方账号身份及根目录读取权限后才显示“已连接”。保存凭证本身不启用转存。
3. 点击卡片 `转存` 一行的「配置」，在弹窗中选择非根目录并设置清理时间，然后点「转存」保存。失效时点击“重新扫码”，切换身份或阿里空间时选择“更换账号”。
4. “断开连接”只移除本系统凭证，不注销官方账号、不删除网盘文件、不撤销官方 App 里的所有授权。

每个网盘仅配置一个全站管理员服务账号；这不是网站用户绑定个人网盘的功能。
不要通过聊天、截图、Git 或日志分享 Cookie、refresh_token、设备私钥。

## 能力与限制

| 网盘 | 登录入口 | 自动维护 |
| --- | --- | --- |
| 夸克 | 扫码、高级 Cookie 导入 | 持久化认证响应中的 Cookie 更新；定期验证，失效需重扫 |
| 百度 | 扫码、高级 Cookie 导入 | 同上；不是通过定时请求保证永久登录 |
| 阿里 | 扫码、高级 JSON 导入 | 刷新 access_token / refresh_token；维护同一设备密钥和签名 |
| 光鸭 | 设备码扫码、高级 JSON 导入 | 按设备授权及刷新接口维护令牌 |
| 迅雷 | 高级 JSON 导入 | 有 refresh_token 时刷新访问令牌；captcha/风控凭据可能仍需手动更新 |

扫码适配参考公开客户端与官方网页登录协议，不是声称这些接口有稳定的官方开放 API 保证。
已核对阿里、百度、光鸭的公共二维码生成响应结构；真实账号扫码、续期及业务权限仍需管理员实测。
测试中的模拟响应只能证明本系统的状态机和保护逻辑，不能替代真实平台验证。
撤销授权、异地风控、设备限制等都可能要求重新授权，不能保证“一次扫码永久有效”。

## 密钥与部署

- 新凭证、刷新中间结果、扫码会话均使用 AES-256-GCM；账号凭证的认证上下文包含 provider、稳定账号标识、绑定版本和凭证版本。
- 默认密钥为运行目录下 `data/cloud-credentials.key`，首次需要时原子生成，权限 `0600`。本目录已被 Git 忽略。
- 设置 `PANSOU_CLOUD_KEY_FILE` 可指定持久化绝对路径；或通过 `PANSOU_CLOUD_CREDENTIAL_KEY` 提供 Base64 编码的随机 32 字节密钥。
- 不要将 `.env.example` 中注释的空密钥变量直接启用。明确设置为空会被视作无效密钥，而不是自动生成。
- API、独立 link-worker 和多副本必须共享同一密钥。生产环境使用 HTTPS，并让反向代理保留原始 Host。认证写接口检查 Origin / Sec-Fetch-Site。
- 备份数据库时同时备份密钥；新凭证字段不可凭数据库单独恢复。丢失密钥后须恢复原密钥，不能靠生成新密钥解密旧数据。
- 认证 Worker 随 `serve` 和 `link-worker` 启动，不受采集、检测、转存和清理开关影响；跨进程由 PostgreSQL 租约协调。
- 所有凭证、身份检查和登录会话 API 响应为 `Cache-Control: no-store, private`。不向浏览器返回凭证、授权票据、设备私钥或官方接口原始响应。

## 旧数据与任务安全

旧明文凭证不会在数据库迁移时自动抹除，页面显示“待验证”。管理员检查成功后才转换为加密凭证并清空明文字段。
旧 Cookie 指纹仅在官方身份被核实后建立别名，并迁移对应的缓存归属；无法核实的旧指纹不会猜测归属。
短期令牌更新增加 token_revision，不改变稳定 account_key 或 binding_epoch；更换账号或空间改变绑定版本。
断开连接、取消扫码或替换会话会阻止旧结果覆盖新状态。
保存凭证时若扫码账号与已存账号不一致，会拒绝写入并按原因给出**两种不同**的错误码：`account_mismatch` 表示旧凭证仍可验证、且确实属于另一个账号（用户扫了别的号）；`account_unverified` 表示旧凭证已失效、身份从未核实过，因此**无法判断**是否同一账号。两者都要求用户明确选择“更换账号”（或先“断开连接”再连接），绝不静默接管旧账号的产物归属；区别只在于提示语——后者不会断言“不一致”。页面对「凭证存在但从未完成身份核实」（`configured` 且无 `subjectId`）的账号直接给出提示，并让该状态下的「重新扫码」按换绑意图发起，避免用户在扫码之后才发现这一步必然失败。
扫码过程中若账号行或扫码会话本身发生变化（`binding_epoch`/`token_revision` 被改动、会话被取消或替代），失败码是 `state_changed`，**不会**被归为 `account_mismatch`：这两类失败的处理方式完全不同，把状态竞争说成“扫了另一个账号”会把管理员引向无关的操作。

清理遇到明确认证失败时标记 `blocked / waiting_auth`，保留产物且不消耗重试次数。
同一已验证身份重新连接后仅恢复等待授权的任务，不恢复归属不明的任务，也不把旧账号产物交给新账号删除。
刷新令牌响应先加密暂存，再验证身份和目录；暂时失败仅重试验证，不再兑换旧令牌。
若刷新请求超时或进程在结果落库前退出，结果不确定时要求重新授权，不盲目重放刷新，更不重放转存、分享或删除。

## 开发验证

运行 `cargo test --locked`、前端 `pnpm test` / `pnpm typecheck` / `pnpm build`。
隔离集成测试 `cloud_auth::tests::encrypted_bindings_refresh_sessions_and_ownership_are_fenced` 需要：

- `PANSOU_TEST_DATABASE_URL` 指向名称以 `_test` 结尾的专用 PostgreSQL 数据库；
- `PANSOU_TEST_REDIS_URL` 指向非默认 Redis DB；
- `PANSOU_CLOUD_CREDENTIAL_KEY` 提供只用于测试的密钥，避免写入生产密钥文件。

测试覆盖加密/脱敏、官方身份核实、Cookie 旋转、并发刷新、暂存恢复、不确定刷新、账号替换、旧凭证 CAS、会话取消、管理员隔离及旧产物迁移。

扫码失败会显示具体阶段：兑换扫码授权、核实官方账号、验证根目录访问、保存账号凭证。
后台仅记录阶段、固定错误码及状态码，不记录原始接口响应或凭证。
光鸭 `/v1/user/me` 必须使用 GET；POST 会返回 `501 unimplemented`。回归模拟接口现在严格校验方法，避免宽松模拟掩盖真实协议错误。
光鸭设备码响应里的 `verification_uri_complete` 指向 `account.guangyapan.com/__/auth/device/`，该路径由 nginx 返回 404；同一页面在 `www.guangyapan.com/__/auth/device/` 是 200。服务端只把 `account.guangyapan.com` 这一个 host 改写为 www，其他 host 原样保留，便于上游修复后自动生效。
登录跳转的白名单按**服务商自有域名**（`quark.cn` / `baidu.com` / `aliyundrive.com` / `alipan.com` / `guangyapan.com` / `xunlei.com` 及其子域）判断，而不是固定 host 列表。夸克会把扫码会话交接到 `b.quark.cn`，百度 passport 链可能经过 `wappass.baidu.com`；固定列表会把这些正常跳转误判成协议错误（表现为 `token_exchange:provider_protocol_error`）。`checked_url` 仍强制 https 与 443 端口，`baidu_login_url` 仍限定在百度自有域名内。
光鸭刷新令牌请求必须带 `x-action: 401`，否则账号服务不会轮换令牌。
夸克 CAS 二维码接口的成功状态为 `status=2000000`，但 `/account/info` 的信封是 `success=true, code="OK"`。匿名访问也会返回 `success=true, code="OK"` 且 `data` 为**空对象**，所以「`data` 非空」才是会话已建立的证据，不能用信封的 `success`/`code` 判断。**线上返回的账号载荷是 `{avatarUri, config, mobilekps, nickname}`，完全没有 id 字段**，账号 ID 在兑换时一并下发的 `__uid` Cookie 里（同批还有 `__pus` / `__kp` / `__kps` / `__ktd`）。服务端先按 `uid` / `user_id` / `userId` / `uk` / `sub` / `id` 依次从载荷里找（`id` 放最后，避免误取无关 id，并允许被 `user` / `member` / `account` / `profile` / `info` / `data` 包一层），找不到再回退到 `__uid` Cookie；两者都拿不到有效 ID（含空串与占位值 `0`）时按未授权处理，绝不会把匿名或半登录响应当成会话。
夸克扫码兑换遵循浏览器行为：CAS 票据通过 `pan.quark.cn/account/info?st=…&lw=scan` 的整条重定向链建立会话，Cookie 可能出现在任一跳的 `Set-Cookie` 上，因此服务端手动逐跳跟随（每跳目标都重新校验域名白名单），兑换后用新的 `/account/info` 请求核实会话确实建立，才把 Cookie 保存为凭证；未建立会话的扫码在兑换阶段快速失败，不会保存匿名凭证。
夸克兑换阶段的日志只记录信封元数据：每跳的顶层键名、`success`、`code`（截断）以及兑换后捕获到的 **Cookie 名称**（不含值）；身份解析失败时记录 `data` 的键名与 `__uid` 是否存在。这些足以判断「跳转链是否正常」「是否真的下发了 pan 会话 Cookie」「线上返回了哪种字段形态」，且不泄露任何凭据或账号数据。
百度 `passport.baidu.com/v3/login/main/qrbdusslogin` 的 JSONP 响应**不是合法 JSON**：其中一个键写成单引号（`'data': {…}`），严格解析会整包失败，表现为 `token_exchange:provider_protocol_error` 且日志里 `no=None`。`parse_json` 在严格解析失败后才规范化单引号标识符键，以及双引号字符串里的 JavaScript 转义：十六进制、Unicode 码点、垂直制表符、旧式八进制、续行及 NonEscapeCharacter（例如 `\&` → `&`）。依据 [ECMAScript 字符串字面量规则](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-literals-string-literals) 还原字符串，不执行 JavaScript；表达式、括号不平衡、单引号值、坏的十六进制或 Unicode 转义仍返回 `None`，已经合法的 JSON 不改写。

百度兑换响应无法解析时，诊断只记录响应字节数、是否有 JSONP 包装、单引号键修复是否完成、解析错误的行列与类别，以及 Content-Type；兑换状态码缺失时只记录固定字段是否存在。不会记录响应正文、扫码票据或 Cookie 值。这些信息用于区分响应格式变化与平台拒绝授权；匿名错误响应解析通过不等于真实扫码已通过。

`qrbdusslogin` 的响应体本质是浏览器用 `<script>` 求值的 JSONP **JavaScript 实参**，不是 JSON：除了单引号键，任何仅 JS 合法的语法都可能出现（2026-10-03 实测确认，第三方客户端也全部不解析该响应体，只从 Set-Cookie 取 BDUSS）。因此兑换响应解析是**尽力而为**：能解析出 `data.u` 就照常走浏览器式跳转链；解析失败时以**响应是否直接下发 BDUSS/BDUSS_BFESS 会话 Cookie** 为准——有会话 Cookie 就补一次 `pan.baidu.com` 落地请求（对齐浏览器登录后的跳转）继续流程，没有则按失败处理：信封可解析且 `errInfo.no != 0`（如 310005 票据过期）返回 `reauthorization_required`（提示重新扫码），否则维持 `provider_protocol_error`。凭据保存仍由后续官方身份核实与根目录读取把关，匿名 Cookie 不可能被存成账号。

以下均为 2026-10-03 用真实账号实测确认的百度网盘接口契约（此前按旧文档实现，导致“转存显示成功但交付失败”）：
- `/share/transfer` 成功响应的新文件 ID 在 **`extra.list[].to_fs_id`**；`info[]` 只回显源 `fsid`。旧文档的 `info[].to_fs_id/new_fs_id` 形状作为回退保留。解析不到任何 ID 视为转存结果不确定，不当作成功。
- `/api/filemanager` 删除必须每项同时携带 **`fs_id` 和 `path`**（仅 `fs_id` 返回 errno 12），与网页客户端一致。
- `/api/create` 创建目录的响应**不含 `server_filename`**；交付证据记录的目录名从返回的 `path` 末段补齐（百度对重名目录会自动加后缀，以响应为准）。
- 空目录的 `/api/list` 正常返回 `errno=0` 与空 `list`；删除/重命名等写操作偶发返回 HTTP 200 但空响应体，此时视为结果未确认而不是成功。

夸克分享任务被拒的业务码 **41026 表示内容未通过平台审核（禁止分享）**，与过期参数无关（实测 permanent/7 天/自定义 `expired_at` 三种组合全部同样失败）。这是平台侧限制，无法通过重试或参数变化解除；系统将其映射为明确错误 `夸克拒绝分享：文件未通过平台审核或账号分享受限`，产物按显式拒绝记录 `share_failed` 并回退原始链接，不再伪装成传输不确定。

光鸭 `userres/v1/file/get_file_list` 对**空目录**返回 `{"msg":"success","data":{}}`——`data` 里没有任何列表字段。把"没有列表字段"一律当错误会让空目录（包括每次转存新建的交付目录）在目录选择和交付流程中 502。现在仅当 `msg=="success"` 且找不到列表字段时按空目录处理，其余形状仍然失败关闭。

光鸭 `share_file` 的两处实测契约（2026-10-03）：`validateDuration` 单位是**秒**（0 为永久），传天数会让分享在几秒后过期；响应的 `shareId` 是纯数字，而分享 URL 的 key 是 `<数字id>_<后缀>`，归属校验按"URL key 以报告的 shareId 为前缀"判断，其余形状仍视为不一致并暂停处置。

光鸭新建交付分享使用 `shareType: 0`（无提取码），`autoFillCode: false`；`shareType: 1` 才是随机生成提取码，`autoFillCode` 只控制是否在链接中自动填码。返回、打开和复制统一使用 `https://www.guangyapan.com/s/<key>#/share`；有提取码时使用 `?code=<提取码>#/share`，复制只写入这一条 URL。仅接受合法分享链接，不修复粘连路径或改写旧缓存。契约参考[光鸭官网客户端](https://www.guangyapan.com/static/js/index.2795c2ad.js)。

百度交付的**解析缓存**：解析分享页包含提取码验证、HTML 和分页分享列表。交付完成解析后仅把公开分享身份 `{shareId, owner}` 写入 Redis（30 分钟 TTL，key 含链接指纹），下一次跳过 HTML，但仍验证提取码并读取当前分享文件。旧文件清单不会复用；缓存过期或不匹配时完整解析。取链已改为异步查询，不再受 5 秒窗口中断，转存结果仍按精确文件清单核对。
