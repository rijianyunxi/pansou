# 网盘接入探索 · wangpan 分支

> 本分支是一个**探索性分支**：已清空原有 PanHub 代码，只保留这份调研文档。
> 原项目代码完整保留在 `main` 与 `rust` 分支，本分支不影响它们。

调研时间：2026-09。各平台的开放策略与价格变动频繁，落地前请以官方文档为准。

---

## 1. 目标

PanHub 现在只对接了 **百度网盘** 和 **夸克网盘** 两个网盘的 Cookie（用于"删云端"）。
本分支要回答一个问题：

> 如果要给 PanHub 扩展更多网盘能力（删除、转存、直链、列目录、上传），
> **每个网盘分别能走哪条路？官方 API、逆向接口、开源 SDK、MCP/Skill，各自可行性和成本如何？**

下面按"能力来源"分四层梳理：**官方开放平台 → 非官方/逆向接口 → 开源 SDK 与 CLI → MCP / Agent Skill**，
最后给出聚合方案与推荐路线。

---

## 2. 总览对比

| 网盘 | 官方开放 API | 鉴权方式 | 成熟开源 SDK/CLI | MCP / Skill | PanHub 现有对接 |
|------|:---:|------|------|:---:|:---:|
| 百度网盘 | ✅ 完善 | OAuth 2.0 / Cookie | BaiduPCS-Go 等 | ✅ 官方开源 MCP | Cookie（删除） |
| 阿里云盘 | ⚠️ 个人版策略多变 | OAuth / 扫码 | tickstep/aliyunpan（Go） | ⚠️ 社区自建 | ❌ |
| 夸克网盘 | ❌ 无公开 API | Cookie + 动态 token | quark-api、quark-auto-save | ❌ | Cookie（删除） |
| 115 / 115生活 | ✅ 官方开放平台 | OAuth + 开发者申请 | open-115-sdk-js | ❌ | ❌ |
| 123 云盘 | ✅ 官方（已转付费） | 密钥鉴权 | 123pan-api-sdk（TS） | ❌ | ❌ |
| 天翼云盘 | ⚠️ 有但不完全开放 | Cookie / 逆向 | 社区直链工具 | ❌ | ❌ |
| 腾讯微云 | ⚠️ 有 SDK | OAuth | 官方 Weiyun SDK | ❌ | ❌ |
| 迅雷云盘 | ❌ 无公开 API | 逆向 | 社区直链工具 | ❌ | ❌ |
| 移动云盘（139） | ❌ 无公开 API | 逆向 | 社区直链工具 | ❌ | ❌ |
| 蓝奏云 | ❌ 无公开 API | 逆向 | 社区直链工具 | ❌ | ❌ |
| 坚果云 | ✅ 官方 WebDAV | Basic Auth | 通用 WebDAV 客户端 | ❌ | ❌ |
| Google Drive / OneDrive / Dropbox / MEGA | ✅ 完善 | OAuth 2.0 | 各语言官方 SDK | 多个社区 MCP | ❌ |

**一句话结论**：国内网盘只有少数（百度、115、123）提供真正可用的官方 API；
其余要么靠逆向，要么靠"聚合器"（OpenList）间接拿到统一接口。

---

## 3. 逐个网盘：能力与接入方式

### 3.1 百度网盘 —— 官方能力最完整

- **官方开放平台**：`pan.baidu.com/union`，基于 **OAuth 2.0** 授权。
  支持**目录级授权**（只授权部分目录、不需全盘权限），官方文档明确点名该模式适用于 **MCP、文件管理**类应用。
- **官方 MCP Server**：百度网盘已**开源 MCP 服务器**（`github.com/baidu-netdisk/mcp`），
  核心 API 全面兼容 MCP 协议。当前提供四类能力：
  1. 文件查询与搜索
  2. 文件管理（含删除/移动等）
  3. 文件分享
  4. 用户与容量
- **现状**：PanHub 目前用 **Cookie**（校验 `BDUSS`/`BDUSS_BFESS` + `BAIDUID` + `STOKEN`）直接调 Web 接口删除。
- **建议**：删除这类"写操作"若能迁到官方 MCP / OpenAPI，稳定性和合规性都更好；
  Cookie 方案作为兜底保留。

### 3.2 阿里云盘 —— 能力有，但个人版入口不稳定

- **开发者门户**：`aliyundrive.com/developer`；企业侧有 **PDS（网盘与相册服务）** 开放平台，
  OpenAPI 采用 ROA 签名风格，提供多语言预置 SDK（`api.aliyun.com/product/pds`）。
- **开源 SDK**：官方有 iOS SDK（`alibaba/aliyunpan-ios-sdk`）。
- **CLI**：社区 **`tickstep/aliyunpan`**（Go 编写，仿 Linux shell 交互，支持 JavaScript 插件、同步备份），
  是目前最活跃的个人版客户端工具。
- **MCP**：阿里云有官方 OpenAPI MCP Server（`aliyun/alibabacloud-api-mcp-server`，面向云产品 OpenAPI）；
  阿里云盘个人版的 MCP 多为社区"手搓"（扫码换 token + 若干工具）。
- **风险**：个人版开放平台策略调整频繁，第三方接口随时可能失效；落地前需评估长期可用性。

### 3.3 夸克网盘 —— 纯逆向，无官方 API

- **无官方公开 API**。Web/App 接口鉴权严格（动态 token、设备指纹），
  且目前无法通过官方途径拉取全量目录树。
- **开源实现**：
  - `wlor0623/quark-api`：纯 HTTP 协议，不依赖特定语言 SDK，curl / Python / Go 均可调用。
  - `Cp0204/quark-auto-save`：签到、自动转存、命名整理、推送提醒、刷新媒体库一条龙（含 API Wiki）。
- **现状**：PanHub 用 Cookie 做删除。
- **建议**：作为"能力补充"可行，但要接受**接口不稳定、需持续维护**的现实。

### 3.4 115 / 115生活 —— 官方开放平台，门槛在申请

- **官方开放平台**：`open.115.com`，提供文件存储、同步、管理的 API 接口。
  接入需**注册账号 + 实名认证 + 提交开发者申请**，通过后按身份授权。
- **开源 SDK**：`lzj0223/open-115-sdk-js`（JS）。
- **聚合支持**：OpenList 有 `115_open` 驱动，可通过授权页把 115 挂进统一文件系统。
- **建议**：如果目标是"稳定长期"，115 是除百度外**第二值得走官方路线**的网盘。

### 3.5 123 云盘 —— 官方 API 已转付费

- **官方开放平台**：密钥鉴权，支持文件浏览、上传、直链获取等。
- **成本变化**：OpenAPI **已转为付费**（社区反馈约 ¥20/月），免费抓取途径不稳定。
- **开源 SDK**：`Shijf/123pan-api-sdk`（Node.js / TypeScript，类型完整）。
- **建议**：有预算再考虑；否则优先级靠后。

### 3.6 天翼云盘 / 迅雷云盘 / 移动云盘(139) / 蓝奏云 —— 逆向 + 直链

- 这四个普遍**无稳定公开 API**，社区方案集中在**分享链接转直链**：
  - `netdisk-fast-download`：支持蓝奏云、奶牛快传、移动云空间等。
  - `LinkSwift`：JS 工具，覆盖百度、阿里、中国移动云盘等八大平台直链解析。
  - `JxPan`：基于 Cloudflare Workers 的网盘直链解析。
- **特点**：直链解析**失效快**，需跟随平台改版更新；适合做"下载加速"，不适合做需要账号态的写操作。

### 3.7 国际网盘 —— 官方 API 最规范

- **Google Drive / OneDrive / Dropbox / MEGA**：官方 OAuth 2.0 + 各语言官方 SDK，文档完善。
- 生态中已有**多个社区 MCP Server**，接入门槛最低。
- **注意**：国内网络可达性与合规需单独评估。

### 3.8 坚果云 —— 官方 WebDAV

- 提供**官方 WebDAV 接口**（Basic Auth），可直接用通用 WebDAV 客户端读写。
- 适合作为"标准协议"对照组：凡是支持 WebDAV 的网盘，都能用同一套代码接入。

---

## 4. 聚合方案：OpenList / AList

不想逐个对接官方 API / 逆向接口时，最省力的路子是**挂一个聚合器**：

- **OpenList**：AList 的社区维护分支（原 AList 已被出售，社区另起炉灶）。
  支持**数十种存储驱动**——阿里云盘、百度网盘、夸克、115、OneDrive、WebDAV、S3 等。
  对外统一暴露 **HTTP API + WebDAV**，PanHub 只需对接一个上游即可覆盖多个网盘。
- **代价**：多一层服务要部署和维护；聚合器的驱动失效时同样需要等社区修复。
- **适用判断**：
  - 只需**读/列目录/直链** → 聚合器性价比最高。
  - 需要**账号态的写操作（删除/转存）** → 仍建议直连官方 API（如百度 MCP）。

---

## 5. MCP / Agent Skill 生态现状

| 类型 | 代表 | 说明 |
|------|------|------|
| 官方 MCP | 百度网盘 MCP（开源） | 文件查询/搜索、管理、分享、用户与容量 |
| 官方 MCP | 阿里云 OpenAPI MCP Server | 面向阿里云各产品 OpenAPI，非个人盘专用 |
| 社区 MCP | 阿里云盘"手搓"MCP | 扫码换 token + 自定义工具集 |
| 聚合器 API | OpenList | 统一 HTTP / WebDAV，可再包一层 MCP |
| 无 | 夸克、迅雷、139、蓝奏云 | 只能自行封装逆向接口为工具 |

**趋势判断**：百度已把"网盘能力"标准化为 MCP 工具，是最值得优先接入的样板；
其余网盘短期内仍以"自建工具封装"为主。

---

## 6. 推荐路线（按优先级）

1. **百度网盘** → 从 Cookie 升级到 **官方 OpenAPI / 官方 MCP**（目录级授权 + 写操作合规）。
2. **阿里云盘** → 用 `tickstep/aliyunpan` 或官方 PDS 打通"列目录 / 直链"，
   注意个人版接口稳定性，做好降级。
3. **聚合层** → 部署 **OpenList** 统一读能力，减少逐个对接的维护面。
4. **115 / 123** → 有长期稳定需求时走官方开放平台（115 需开发者申请；123 需付费）。
5. **夸克 / 天翼 / 迅雷 / 139 / 蓝奏云** → 保留 Cookie / 逆向方案作为补充，
   明确标注"不稳定、需持续维护"，不承载关键路径。

---

## 7. 参考来源

- 百度网盘开放平台 · 授权介绍 / 快速授权 / MCP Server 文档：`pan.baidu.com/union/doc`
- 百度网盘 MCP Server 开源仓库：`github.com/baidu-netdisk/mcp`
- 阿里云盘开发者门户：`aliyundrive.com/developer`；PDS OpenAPI：`api.aliyun.com/product/pds`
- 阿里云盘 CLI：`github.com/tickstep/aliyunpan`
- 夸克网盘 API：`github.com/wlor0623/quark-api`、`github.com/Cp0204/quark-auto-save`
- 115 开放平台：`open.115.com`；SDK：`github.com/lzj0223/open-115-sdk-js`
- 123 云盘 SDK：`github.com/Shijf/123pan-api-sdk`
- 聚合器：OpenList `doc.oplist.org`
- 直链解析：`netdisk-fast-download`、`LinkSwift`、`github.com/ByLsPro/JxPan`
