# wangpan · 夸克 / 百度网盘链接工具

> 纯 Node.js（零依赖）实现的网盘链接处理工具，支持 **夸克网盘** 与 **百度网盘**。
> 这是 `wangpan` 分支的探索性实现，原 PanHub 项目代码在 `main` / `rust` 分支。

各网盘的接入能力调研见 [docs/cloud-drive-research.md](./docs/cloud-drive-research.md)。

---

## 能力

| 能力 | 说明 | 命令 |
|------|------|------|
| ① 链接校验 | 判断分享链接是否有效（失效 / 提取码错误 / 正常），并列出文件清单 | `check` |
| ② 转存到自己网盘 | 把分享内容保存到自己的网盘 | `save` |
| ② 按自己的分享链接删除 | 用"我自己的分享链接"定位并删除我网盘中的资源 | `delete` |
| ③ 已有资源检测 + 复用分享 | 检测资源是否已在自己网盘（名称+大小，百度优先 md5），命中则直接为已有资源创建分享 | `save --dedup` |
| 辅助 | 列出我网盘目录 / 校验 Cookie 可用性 | `mine` / `ping` |

> 重点实现的是 ① 和 ②；③ 为尽力实现（基于文件名+大小/md5 的启发式匹配）。

---

## 快速开始

要求 **Node.js ≥ 22**（使用原生 `fetch` 与 `AbortSignal.timeout`，无第三方依赖）。

```bash
# 1. 配置 Cookie
cp .env.example .env
# 编辑 .env，填入 QUARK_COOKIE / BAIDU_COOKIE

# 2. 跑一遍离线自测（不需要 Cookie）
npm test

# 3. 使用
node src/cli.js ping --provider quark
```

### 获取 Cookie

- **夸克**：浏览器登录 `pan.quark.cn` → F12 → Network → 任意请求 → 复制请求头里的完整 `Cookie`。
- **百度**：浏览器登录 `pan.baidu.com/disk/main` → F12 → Network → 找到 `main` 请求 → 复制完整 `Cookie`。
  必须包含 `BDUSS`（或 `BDUSS_BFESS`）、`BAIDUID`、`STOKEN`。

> 建议用无痕窗口登录后获取，避免与日常登录态冲突。Cookie 通常几小时到几天过期。

---

## 命令用法

```bash
# ① 校验链接是否有效
node src/cli.js check "https://pan.quark.cn/s/abcdef123456"
node src/cli.js check "https://pan.baidu.com/s/1abcdef?pwd=abcd"

# ② 转存到自己的网盘（百度 --to 传目录路径，夸克 --to 传目录 fid，默认根目录）
node src/cli.js save "https://pan.quark.cn/s/abcdef123456"
node src/cli.js save "https://pan.baidu.com/s/1abcdef?pwd=abcd" --to "/来自分享"

# ③ 先检测是否已存在，命中则直接复用已有资源的分享链接
node src/cli.js save "https://pan.quark.cn/s/abcdef123456" --dedup

# ② 按"我自己的分享链接"删除我网盘中的资源（删除需 --yes 确认）
node src/cli.js delete "https://pan.quark.cn/s/myshare" --yes

# 辅助
node src/cli.js mine --provider baidu --dir "/"
node src/cli.js ping --provider baidu
```

加 `--json` 可输出机器可读的 JSON。

---

## 作为库使用

```js
import { checkLink, saveLink, checkExistingAndShare, deleteMyShare } from "./src/index.js";

// ① 校验
const info = await checkLink("https://pan.quark.cn/s/abcdef123456");
if (info.valid) console.log(info.fileCount, info.files);

// ③ 去重复用：命中已有资源时直接返回该资源的分享链接
const dup = await checkExistingAndShare("https://pan.quark.cn/s/abcdef123456", { autoShare: true });
if (dup.alreadyExists) console.log("已存在，分享链接：", dup.share.url);

// ② 转存
await saveLink("https://pan.quark.cn/s/abcdef123456", { toDir: "0" });

// ② 按自己的分享链接删除
await deleteMyShare("https://pan.quark.cn/s/myshare");
```

每个网盘的客户端也可单独使用：`QuarkClient`、`BaiduClient`（见 `src/providers/`）。

---

## 实现要点

### 夸克（`src/providers/quark.js`）

| 步骤 | 接口 |
|------|------|
| 取分享令牌 | `POST {share}/share/sharepage/token` → `data.stoken` |
| 分享详情 | `GET {share}/share/sharepage/detail` → `data.list[].fid` / `.share_fid_token` |
| 转存 | `POST {pc}/share/sharepage/save` → `data.task_id` → 轮询 `GET {pc}/task` |
| 列我网盘 | `GET {pc}/file/sort` |
| 创建分享 | `POST {pc}/share` → `POST {pc}/share/password` |
| 删除 | `POST {pc}/file/delete`（`action_type:2`）→ 轮询 task |

### 百度（`src/providers/baidu.js`）

| 步骤 | 接口 |
|------|------|
| 取 bdstoken | `GET /api/gettemplatevariable` |
| 解析分享页 | `GET /s/1{surl}` → 提取 `shareid` / `share_uk` |
| 校验提取码 | `POST /share/verify` → `randsk`（即 sekey） |
| 列分享内容 | `GET /share/list` |
| 转存 | `POST /share/transfer`（`fsidlist` + `path`） |
| 列我网盘 | `GET /api/list`（返回 `md5`，可用于精确去重） |
| 创建分享 | `POST /share/set` → `link` + `pwd` |
| 删除 | `POST /api/filemanager?opera=delete` |

域名可通过 `QUARK_SHARE_BASE` / `QUARK_PC_BASE` / `BAIDU_BASE` 覆盖，接口改版时无需改代码。

---

## 已知限制

- **未用真实账号验证**：代码按公开的 Web 接口协议实现，离线自测覆盖链接解析与工具逻辑，
  但**接口连通性需要你用自己的 Cookie 实测**（`ping` → `check` → `save` 逐步验证）。
- **非官方接口**：夸克无公开 API，百度走的是 Web 接口；官方改版会失效，需要跟着调整。
- **风控**：百度单账号每日创建分享上限约 300 个，转存建议每次间隔 ≥ 1 秒；批量操作易触发风控。
- **去重是启发式**：夸克按"文件名 + 大小"，百度优先 md5、退化到"文件名 + 大小"，
  同名不同内容或内容相同但改名的情况会误判。
- **删除逻辑**：按"自己的分享链接"删除时，依赖分享内条目 id 与你网盘内 id 一致
  （自己的分享成立，转存来的第三方分享不成立）。
- 转存目标目录：夸克用目录 fid，百度用目录路径字符串。

---

## 目录结构

```text
src/
  cli.js               命令行入口
  index.js             统一工作流（check / save / dedup / delete）
  lib/util.js          Cookie、延时、格式化、错误类型
  providers/quark.js   夸克实现
  providers/baidu.js   百度实现
test/parse.test.js     离线自测（node:test，无需网络）
docs/cloud-drive-research.md   各网盘接入能力调研
```
