# wangpan · 夸克 / 百度网盘链接工具

> 纯 Node.js（零依赖）实现的网盘链接处理工具，支持 **夸克网盘** 与 **百度网盘**。
> 这是 `wangpan` 分支的探索性实现，原 PanHub 项目代码在 `main` / `rust` 分支。

各网盘的接入能力调研见 [docs/cloud-drive-research.md](./docs/cloud-drive-research.md)。

---

## 能力

| 能力 | 说明 | 命令 |
|------|------|------|
| ① 链接校验 | 判断分享链接是否有效（失效 / 提取码错误 / 正常），并列出文件清单 | `check` |
| ② 转存到自己网盘 | 把分享内容保存到自己的网盘，**成功后自动生成「我自己的分享链接」并返回** | `save` |
| ② 按自己的分享链接删除 | 用"我自己的分享链接"定位并删除我网盘中的资源（删除前先列出清单确认） | `delete` |
| ③ 已有资源检测 + 复用分享 | 检测资源是否已在自己网盘，命中则直接为已有资源创建分享 | `save --dedup` |
| 辅助 | 列出我网盘目录 / 校验 Cookie 可用性 | `mine` / `ping` |

> 重点实现的是 ① 和 ②；③ 为尽力实现（启发式匹配，见下）。

### 去重逻辑（能力 ③）

`checkExistingAndShare()` 的判定过程：

1. 解析分享，拿到根目录条目（名称、大小，百度还可能有 md5）；
2. 列出**你网盘目标目录**的内容；
3. 逐条比对：
   - **百度**：优先 `md5` 精确匹配；缺失时退化为 `名称 + 大小`
   - **夸克**：`名称 + 大小`（文件夹 size 恒为 0，实际等价于按名称匹配）
4. 命中任意一条 → `alreadyExists = true`，并对**你网盘里已有的那份**直接建分享；
   全部未命中 → `alreadyExists = false`，走正常转存。

**已知误判**：文件被改名、同名不同内容、同内容不同大小都会判错。百度有 md5 时最可靠；
夸克没有 md5，只能靠名称+大小。

### 转存后返回分享链接（能力 ②）

转存会在你网盘里生成**新的 id**（夸克新 fid、百度新 fs_id），和分享里的 id 不同。
所以 `save` 的流程是：

```
转存成功 → 回到目标目录按名称找回刚保存的条目 → 对它创建分享 → 返回 { url, password }
```

返回结构：

```json
{
  "ok": true,
  "data": {
    "provider": "quark",
    "mode": "saved",
    "saved": true,
    "count": 1,
    "target": "0",
    "names": ["快乐星球电视剧版（1-5季）"],
    "share": { "url": "https://pan.quark.cn/s/xxxx", "password": "abcd" }
  }
}
```

若转存成功但在目标目录找不到对应条目，`share` 为 `null`，界面会给出提示。

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

## 图形界面

内置一个零依赖的本地 Web 服务：

```bash
npm run web        # 打开 http://127.0.0.1:8787
```

界面包含：

- **登录态**：粘贴夸克 / 百度 Cookie，仅保存在进程内存，不落盘
- **网盘选择**：自动识别 / 夸克 / 百度
- **① 链接校验**：填链接即出「有效 / 无效 + 原因 + 文件清单」
- **② 转存 / 去重**：勾选「先去重」→ 已有则直接复用并给出分享链接，没有则照常转存
- **② 删除我的资源**：按自己的分享链接删除（带二次确认）
- **我的网盘**：列目录

服务只监听 `127.0.0.1`，可用 `WANGPAN_PORT` / `WANGPAN_HOST` 调整。

---

## 命令用法

```bash
# ① 校验链接是否有效
node src/cli.js check "https://pan.quark.cn/s/abcdef123456"
node src/cli.js check "https://pan.baidu.com/s/1abcdef?pwd=abcd"

# ② 转存到自己的网盘（百度 --to 传目录路径，夸克 --to 传目录 fid，默认根目录）
#    默认转存成功后生成「我自己的分享链接」并打印；加 --no-share 可关闭
node src/cli.js save "https://pan.quark.cn/s/abcdef123456"
node src/cli.js save "https://pan.baidu.com/s/1abcdef?pwd=abcd" --to "/来自分享"
node src/cli.js save "https://pan.quark.cn/s/abcdef123456" --no-share

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
- **超时保护**：请求与读响应体共用同一个超时窗口（`WANGPAN_TIMEOUT_MS`，默认 30s）。
  上游返回响应头后 body 迟迟不结束时也能在超时后失败，不会无限挂起。

---

## 目录结构

```text
src/
  cli.js               命令行入口
  server.js            本地 Web 服务（图形界面后端）
  index.js             统一工作流（check / save / dedup / delete）
  lib/util.js          Cookie、超时请求、延时、格式化、错误类型
  providers/quark.js   夸克实现
  providers/baidu.js   百度实现
public/                图形界面（index.html / style.css / app.js）
test/parse.test.js     离线自测（node:test，无需网络）
docs/cloud-drive-research.md   各网盘接入能力调研
```
