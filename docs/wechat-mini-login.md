# 微信小程序登录接入方案

## 适用范围与交付

本次接入“小程序内微信登录 → 调用现有盘搜 API”，并在此基础上补齐**网站扫码登录**（二维码挑战 + 轮询 + 网页会话兑换）。当前主站是 Nuxt 网站，因此另外提供可导入微信开发者工具的 `miniprogram/` 登录项目，后端与网站共用 users、sessions 和后台账号管理。普通用户不通过网站自助注册或常规登录入口，首次微信登录即自动建号；管理员仍从 `/admin` 使用管理员账号密码。后台的“创建管理员”只用于新增管理员，普通账号一律由小程序首次登录自动创建。普通网页不能直接调用 wx.login，网站扫码由小程序确认后完成登录，流程见下文「网站扫码登录」。

## 官方依据（2026-09-17 核对）

- [小程序登录流程](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)：wx.login → 后端 code2Session → 自定义登录态，code 仅可使用一次，session_key 不可下发客户端。
- [wx.login](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)：code 有效期五分钟。
- [小程序登录凭证校验 code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)：固定请求 GET https://api.weixin.qq.com/sns/jscode2session，参数 appid、secret、js_code、grant_type=authorization_code。UnionID 为可选信息。

官方旧地址 `OpenApiDoc/user-login/code2Session.html` 当前返回接口列表，应使用上面的新版详情地址。

登录只识别微信身份，不获取手机号、头像或昵称，也不以客户端提交的 openid、unionid、用户资料作为登录依据。手机号等授权不属于本次范围。

## 登录与身份关联

1. 用户点击小程序“微信登录”，小程序调用 wx.login 获取 code。
2. POST /api/account/wechat/login，JSON 为 `{ "code": "微信临时凭证" }`。
3. 服务端使用私有 AppID / AppSecret 调用微信，超时 8 秒，不自动重试一次性 code；不记录微信请求 URL 和异常原文。
4. 以 `(provider, provider_app_id, subject)` 查找通用 `auth_identities`，关联现有 users.id。UnionID 仅保存为元数据，不自动合并跨应用账号。
5. 签发 32 字节随机、不透明 Bearer token，数据库仅保存 SHA-256 摘要，过期时间沿用后台 sessionDays。
6. 小程序后续请求添加 `Authorization: Bearer <token>`。搜索、个人资料、频道管理等仍走现有权限校验。

成功响应：`{ ok, user, token, tokenType: "Bearer", expiresAt }`，expiresAt 是毫秒 Unix 时间戳。响应不会包含 AppSecret、openid、unionid 或 session_key；session_key 不落库。

首次微信登录会为该 openid 自动创建一个普通账号（用户名形如 `wx_` + 12 位十六进制，密码随机生成且从不返回，账号只能通过微信进入），并写入 `auth_identities`。这条路径不需要管理员预先创建账号，也**没有“绑定已有账号”这一步**：原先的“管理员预创建 + 用户绑定”准入模型已于 2026-09-18 整体删除。管理员账号禁止通过微信进入，始终从 `/admin` 走账号密码登录；即使某管理员账号被手工写入了 `auth_identities`，身份解析也会以 403 拒绝。

自动建号意味着任何能打开小程序的人都能获得一个账号，因此准入控制依赖后台的禁用/删除与登录限流，而不是注册审批。

`autoProvision` 现在是**唯一的准入开关**：在 `resolveExternalUser` 调用处去掉它，未关联过的微信身份会直接拿到 403，且没有任何自助补救路径（绑定通道已删除，后台也无法再创建可被认领的普通账号）。

身份解析抽象为 `ExternalIdentity` 和 `resolveExternalUser`，微信只是当前第一个 provider；未来接入其他 OAuth 时新增 provider 的 code 交换适配器，沿用同一 `auth_identities`、身份解析规则和 Bearer 会话，不改 users 表。

## 网站扫码登录

首页顶栏的登录按钮（`components/UserAccountPanel.vue`，`variant="wechat"`）打开 `components/WechatQrLoginPanel.vue`：浏览器只与本应用通信，从不直连微信。

1. `POST /api/account/wechat/qr/start` — 生成 12 字节随机票据（24 位十六进制），写入 `login_tickets`，再用 `wxa/getwxacodeunlimit` 生成**小程序码**，票据即 `scene`，返回 `{ ticket, qrImage, expiresAt }`。`qrImage` 是 `data:image/png;base64,…`，可直接放进 `<img src>`。票据有效期 3 分钟。access_token 进程内缓存，遇 40001/40014/42001 只刷新一次后重试；生成失败会删除票据，不留孤儿行。
2. 微信扫码打开小程序 `pages/login/index`，`onLoad`（或已在页面时的 `wx.getEnterOptionsSync`）取到 `scene`，用户点「确认登录」后 `POST /api/account/wechat/qr/confirm`，请求体 `{ scene, code }`，`code` 是新取的 `wx.login` 凭证。
3. 服务端用同一套 `exchangeWechatCode` + `resolveWechatUser(..., { autoProvision: true })` 解析账号（因此首次扫码同样自动建号，禁用/删除账号同样被拒），再把票据从 `pending` 原子地改为 `confirmed`。
4. 网页 `GET /api/account/wechat/qr/poll?ticket=…` 每 1.8 秒轮询。只有 `confirmed` 的那一次会返回账号并**一次性**把票据改为 `consumed`，同时把浏览器既有的匿名 cookie 会话轮换成账号会话——与管理员密码登录走同一个 `rotateSession`，所以网站拿到的是普通 cookie 会话，不是 Bearer token。

需要说明的取舍：

- **确认必须由用户在小程序里点击。** 扫码即登录会把「我扫了别人发来的码」变成「我的账号登进了别人的浏览器」，这是典型的二维码钓鱼，所以不做自动确认。
- **票据一次性。** `consumeWechatQrLogin` 的 `UPDATE … WHERE status='confirmed' AND expires_at > ?` 是唯一的发放点，第二个浏览器轮询同一张码只会拿到 `user: null`，也不会新建会话。未知票据与已失效票据一律返回 `expired`，不做区分。
- **轮询不计入登录限流。** 3 分钟内约 100 次请求，与 `prepareWechatRequest` 的 20 次/分钟共用配额会立刻打满，因此轮询走独立的 150 次/分钟限流（`prepareWechatQrPollRequest`）。
- **入口开关同时是接口开关。** 后台关闭「是否展示登录按钮」后，`start` 与 `poll` 都返回 403，避免按钮藏起来了 URL 还可用。
- 二维码指向的页面与打开版本在后台「微信小程序」卡片里配置（默认 `pages/login/index` / `release`），请求固定带 `check_path: false`，未发布的页面不会让生成失败。

## 会话与安全约束

- 数据库创建通用 auth_identities；sessions 使用 transport 区分 cookie 与 bearer。
- Cookie 与 Bearer 分开校验，避免网站 Cookie token 被转换为可读的原生 token；错误 Authorization 不回退到 Cookie。
- 禁用、软删除账号即时阻止微信登录及受保护接口访问，后台撤销会话同时影响小程序。
- `POST /api/account/logout` 删除当前小程序会话，旧 token 立即失效；不影响其他设备。
- 普通账号没有可用的密码登录入口，也不存在自助改密：账号只通过微信身份进入。
- 新接口响应 no-store，登录每 IP 每分钟 20 次进程内限流；网站扫码轮询走独立的 150 次/分钟配额。多实例部署需改用共享限流存储。
- 网站扫码签发的 cookie 会话与小程序 Bearer 会话是两条隔离通道：`createMiniProgramSession` 不写 cookie，`rotateSession` 也不下发 token，因此扫码登录无法把网站会话升级成小程序 token。
- 不使用 wx.checkSession 判断本系统会话有效性；访问业务接口得到 401 后清理本地 token，通过用户操作重新登录，不自动重放写操作。

## 配置与运行

微信配置**全部存在数据库里**（单例表 `wechat_mini_settings`），不再读 `runtimeConfig`，也没有对应的环境变量。后台「系统设置」页的「微信小程序」卡片就是唯一入口，保存后立即生效，不需要改环境变量或重启进程。

| 字段 | 说明 |
|---|---|
| `appId` | 微信公众平台 → 开发管理 → 开发设置 |
| `secret` | AppSecret，**只写不读**（见下） |
| `qrPage` | 小程序码指向的页面，不带前导斜杠，默认 `pages/login/index` |
| `envVersion` | `release` / `trial` / `develop`，默认 `release`。联调未发布的小程序时改成 `trial`，否则扫出来的码打不开页面 |

AppSecret 的处理约定：

- **只写不读。** `wechatMiniSettingsView()` 是唯一允许离开进程的形态，它只报告 `secretConfigured` 与 `secretLength`，不回传值，也**不回传前后缀**——被遮罩的片段依然能缩小猜测范围，而控制台并不需要它。
- **留空 = 不修改。** 控制台拿不到当前值，所以无法回传；提交时留空表示保留已存的密钥。要清空必须显式提交 `null`（这是清掉一个粘错的密钥的唯一途径）。
- 不写日志。读写路径都不打印密钥，也没有任何脱敏流程需要它经过 `core/utils/redaction.ts`——因为这些字段根本不会进入那条通道。

> **风险提示（务必知悉）**：`data/panhub.sqlite` 是**被 git 跟踪**的（`git ls-files data/` 能列出来，历史提交里还有一条 "update local application database"）。因此**这个 AppSecret 会随下一次 commit 进入仓库历史**，与本文档早先"不提交实际密钥"的约定相冲突。当前按「全放数据库、不动 git」的决定执行，请确认该仓库是私有且访问受限。若日后要把 `data/` 移出版本控制，记得已提交的历史里仍有旧库快照（含管理员密码哈希、会话 token 哈希、带 IP 的搜索日志），需要单独清理历史。

校验规则（写入路径严格、读取路径宽容）：

- `appId`：6–64 位字母或数字，空串表示清空（清掉后 `configured` 变假，扫码登录返回 503）。
- `secret`：8–128 位字母、数字、下划线或连字符。
- `qrPage`：字母数字下划线开头，允许后续的 `_ - /`；前导斜杠会被剥掉。
- `envVersion`：只接受 `release` / `trial` / `develop`，其它值返回 400。

非法输入一律 400 且**不落库**（不会静默保留旧值）；反过来，读取路径遇到旧版本写坏的脏值会**降级成默认值**而不是让请求失败——它跑在登录热路径上。表本身缺失也一样容忍：`SCHEMA` 在每次启动时都会 `CREATE TABLE IF NOT EXISTS`，但长跑进程可能比代码旧（本项目的 dev server 就长期持有生产库），此时读取返回"未配置"、写入返回带明确提示的 503，而不是把 `no such table` 当成表单 bug 抛出去。**真实库当前还没有这张表**，会在服务下次启动时自动创建。

在微信开发者工具中导入 `miniprogram/`，把 project.config.json 的 touristappid 替换为真实小程序 AppID，并把 utils/auth.js 的 API_BASE 改成部署后的 HTTPS 域名。在微信公众平台小程序后台把该域名配置为 request 合法域名，再进行真机验证。示例项目包含登录页及通用 API 请求模块，可把 utils/auth.js 合入已有小程序；业务搜索页面未在此示例中复制。

示例：

```js
const auth = require('../../utils/auth');
const user = await auth.login();
const { data } = await auth.request('/api/account/profile');
await auth.logout();
```

修改后运行 `pnpm build` 并用现有发布流程部署。项目未提供真实 AppID / AppSecret，本次不配置生产凭据、不上传审核或发布小程序。

## 验证

执行 `node --test tests/wechat-login.test.mjs`。测试使用临时 SQLite 数据库与模拟微信响应，覆盖 code 校验、密钥不外泄、微信错误映射、首次登录自动建号、关闭自动建号时拒绝未关联身份、重复登录、AppID 隔离、禁用/删除账号、删除账号不被重新建号、管理员账号不可通过微信进入、Bearer/Cookie 隔离、退出、过期、管理员撤销、后台建号产生管理员，以及数据库初始化。

执行 `node --test tests/wechat-qr-login.test.mjs` 覆盖网站扫码：票据格式、未配置凭据返回 503、生成失败不留票据、access_token 缓存与失效刷新一次、未确认/已失效/已消费三种状态、确认只生效一次且只建一个账号、禁用账号在写库前被拒、过期票据被清理，以及 poll 端到端（设置 `HttpOnly` cookie、会话 `kind=user`、同一张码第二个浏览器拿不到账号）。

执行 `node --test tests/wechat-config.test.mjs` 覆盖配置存储：空库默认值、读写往返、视图里**不含密钥值也不含其前后缀**、留空保留密钥与 `null` 清空、清空 AppID 即关闭登录、非法输入 400 且不改动已存行、`qrPage`/`envVersion` 双路径归一化、旧版本写坏的脏值降级，以及两条接线证明——`qr/start` 在库里没凭据时 503、写入凭据后立刻 200 且**发给微信的 `appid`/`secret` 确实取自数据库行**（这是"不再读环境变量"的实证），后台 `GET/PUT /api/settings/wechat` 需要管理员 Bearer 且响应不含密钥。

另执行 Nuxt 生产构建。

上线前需用真实小程序完成：首次登录（自动建号）、重复登录、禁用账号、退出后旧 token 请求失败、真实 code 重复使用失败，以及 HTTPS 合法域名校验。模拟测试不能代替微信真机联调。
