# wangpan · 夸克 / 百度网盘链接工具

> 纯 Node.js（零依赖）实现的网盘链接处理工具，支持 **夸克网盘** 与 **百度网盘**。
> 提供本地图形界面（`npm run web`）。这是 `wangpan` 分支的探索性实现，原 PanHub 项目代码在 `main` / `rust` 分支。

各网盘的接入能力调研见 [docs/cloud-drive-research.md](./docs/cloud-drive-research.md)。

---

## 能力

| 能力 | 说明 | 界面 |
|------|------|------|
| ① 链接校验 | 判断分享链接是否有效（失效 / 提取码错误 / 正常），并列出文件清单 | 「链接校验」标签页 |
| ② 转存到自己网盘 | 把分享内容保存到自己的网盘，**成功后自动生成「我自己的分享链接」并返回** | 「转存 / 去重」标签页 |
| ② 按自己的分享链接删除 | 用"我自己的分享链接"定位并删除我网盘中的资源（删除前先列出清单确认） | 「删除我的资源」标签页 |
| ③ 已有资源检测 + 复用分享 | 检测资源是否已在自己网盘，命中则直接为已有资源创建分享 | 「转存 / 去重」标签页的「先去重」；`/api/existing` |
| 辅助 | 列出我网盘目录 / 校验 Cookie 可用性 | 「我的网盘」/「检测登录态」 |

> 重点实现的是 ① 和 ②；③ 为尽力实现（启发式匹配，见下）。

### 去重逻辑（能力 ③）

`checkExistingAndShare()` 的判定过程：

1. **并行**做两件事：解析分享（拿到根目录条目：名称、大小，百度还可能有 md5）、列出**你网盘目标目录**的内容；
2. 逐条比对：
   - **百度**：优先 `md5` 精确匹配；缺失时退化为 `名称 + 大小`
   - **夸克**：`名称 + 大小`（文件夹 size 恒为 0，实际等价于按名称匹配）
3. 命中任意一条 → `alreadyExists = true`，并对**你网盘里已有的那份**直接建分享；
   全部未命中 → `alreadyExists = false`，走正常转存。

**注意**：去重只在**目标目录这一层**比对，不递归子目录。所以文件在你网盘的子目录里时，
把 `toDir` 指到那个子目录才能命中。

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

### 不能转存"自己的分享"

夸克会直接拒绝（`code 41017`）。这种情况请用「检测已有」（`/api/existing`）——
它会为**你网盘里已有的那份**生成一条新分享链接，正好是你想要的结果。

### 夸克分享是"活链接"（实测）

分享创建后，**往被分享的文件夹里后来添加的内容，会自动出现在分享里**——分享指向的是文件夹本身，
不是创建那一刻的快照。

实测方法（排除了"其实是读我自己网盘"的可能）：

| 请求 | 返回 |
|------|------|
| 正常 `stoken` 读被分享文件夹 | 能读到后来加进去的内容 |
| **伪造的 `stoken`** | `code 14001 非法token` |
| 存在但不属于该分享的 `pdir_fid` | `code 41038 文件没有被分享` |

后两条证明接口**确实在校验分享令牌与分享范围**，不是直接读我的网盘。

> 推论：理论上可以「先转存一部分 → 立即建分享 → 后台把剩下的转进同一个文件夹」，
> 分享链接会自己长齐。但**实测转存本身很快**（`转存` 请求 160ms，任务 ~200ms 完成），
> 慢的从来不是转存，所以这么做收益很小，却要承担"链接早期内容不全"的风险。没有实现。

---

## 快速开始

要求 **Node.js ≥ 22**，**零第三方依赖**（HTTP 走 `node:http` / `node:https`，自建连接池）。

```bash
# 1. 配置 Cookie
cp .env.example .env
# 编辑 .env，填入 QUARK_COOKIE / BAIDU_COOKIE

# 2. 跑一遍离线自测（不需要 Cookie）
npm test

# 3. 启动图形界面
npm run web        # 打开 http://127.0.0.1:8787
```

> **改完 `.env` 需要重启服务**才会生效。

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

- **登录态**：粘贴夸克 / 百度 Cookie，仅保存在进程内存，不落盘；徽标会标明来源（来自 .env / 本次输入）
- **网盘选择**：自动识别 / 夸克 / 百度
- **① 链接校验**：填链接即出「有效 / 无效 + 原因 + 文件清单」
- **② 转存 / 去重**：勾选「先去重」→ 已有则直接复用并给出分享链接，没有则照常转存；
  勾选「转存后生成我的分享链接」→ 转存成功即返回你自己的分享链接
- **② 删除我的资源**：按自己的分享链接删除，**弹窗先列出将删除的条目**再确认
- **我的网盘**：列目录

服务只监听 `127.0.0.1`，可用 `WANGPAN_PORT` / `WANGPAN_HOST` 调整。

---

## HTTP 接口

界面就是调这些接口，也可以直接用：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 查看登录态（是否配置、长度、来源 `env`/`memory`/`none`） |
| POST | `/api/config` | 设置登录态（空值不修改） |
| POST | `/api/config/clear` | 清除界面填写的登录态，回落到 `.env` |
| POST | `/api/check` | ① 校验链接 → `{ valid, reason, fileCount, files }` |
| POST | `/api/save` | ② 转存（`dedup` 去重、`autoShare` 默认 true 返回分享链接） |
| POST | `/api/existing` | ③ 只检测"我网盘是否已有"，命中则直接为已有资源建分享，**不产生转存** |
| POST | `/api/delete` | ② 按自己的分享链接删除 |
| POST | `/api/mine` | 列出我网盘目录 |
| POST | `/api/ping` | 检测登录态是否可用 |
| POST | `/api/warm` | 预热到上游的连接（界面加载时静默调用，无副作用） |

请求体为 JSON。示例：

```bash
# ① 校验
curl -X POST http://127.0.0.1:8787/api/check \
  -H 'content-type: application/json' \
  -d '{"url":"https://pan.quark.cn/s/abcdef123456"}'

# ② 转存并拿到自己的分享链接（toDir：百度传目录路径，夸克传目录 fid）
curl -X POST http://127.0.0.1:8787/api/save \
  -H 'content-type: application/json' \
  -d '{"url":"https://pan.quark.cn/s/abcdef123456","toDir":"","dedup":true,"autoShare":true}'

# ③ 只查已有（不做转存）
curl -X POST http://127.0.0.1:8787/api/existing \
  -H 'content-type: application/json' \
  -d '{"url":"https://pan.quark.cn/s/abcdef123456","toDir":"0"}'

# ② 删除（删除前建议先调 /api/check 确认要删什么）
curl -X POST http://127.0.0.1:8787/api/delete \
  -H 'content-type: application/json' \
  -d '{"url":"https://pan.quark.cn/s/myshare"}'
```

响应统一为 `{ ok: true, data }` 或 `{ ok: false, error, provider }`。
所有响应都带 `timings`（每个上游请求的耗时），界面底部会展示并额外标注**接口真实往返耗时**。

---

## 作为库使用

```js
import { checkLink, saveLink, checkExistingAndShare, deleteMyShare } from "./src/index.js";

// ① 校验
const info = await checkLink("https://pan.quark.cn/s/abcdef123456");
if (info.valid) console.log(info.fileCount, info.files);

// ③ 只查已有：命中已有资源时直接返回该资源的分享链接（不转存）
const dup = await checkExistingAndShare("https://pan.quark.cn/s/abcdef123456", { autoShare: true });
if (dup.alreadyExists) console.log("已存在，分享链接：", dup.share.url);

// ② 转存（dedup:true = 先查已有，命中就复用，未命中才转存；解析只做一次）
await saveLink("https://pan.quark.cn/s/abcdef123456", { toDir: "0", dedup: true, autoShare: true });

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

## 性能

夸克/百度这类接口的延迟几乎全部来自**串行的网络来回**，所以优化都围绕"少发请求 + 别重复握手"。

### 已做的优化

| 优化 | 效果 |
|------|------|
| **自建长保活连接池**（`https.Agent({ keepAlive, maxSockets })`） | 单次请求从 **222~360ms 降到 73~116ms**。原生 `fetch` 走 undici，保活只有 4 秒，空闲稍久就得重新 TCP+TLS 握手；且 Node 22 不提供调整该值的开关，`undici` 也无法 import，只能绕开 `fetch` |
| **连接预热**（界面加载时静默握手） | 一次转存跨 `drive.quark.cn` + `drive-pc.quark.cn` **两个域名**，每个域名首次请求都要付一次握手。预热后 `check` 实测 **429ms → 204ms**。注意要打**真实 API 路径**而不是域名根——实测打根时 socket 有时留不下来（首步 137ms vs 90ms） |
| **复用已解析的分享上下文** | 勾选去重时，原来会**解析两遍分享**（查已有一次、转存又一次）。现在解析一次即可，夸克省 2 个来回、百度省 3 个来回 |
| **去重与列目录并行** | `Promise.all([解析分享, 列我网盘])`，省 1 个来回 |
| **任务已完成时跳过整个轮询** | 夸克对元数据类任务常常同步执行完（响应里带 `task_sync: true` 与完整 `task_resp`）。此时不再轮询，省掉 1~4 个来回 |
| **前 3 秒不采纳上游的轮询建议间隔** | 这是**最大的一处**。上游 `metadata.tq_gap` 给的是 **500ms**（第二轮起 1000ms），那是给长任务的建议值；但这类元数据任务通常几十~几百毫秒就跑完了。照 500ms 等只是让我们晚 500ms 才发现——实测一次 save 有 **1.5s** 全耗在白等上。现在前 3 秒按 150ms 轮询，超过 3 秒（说明是长任务）才采纳上游建议 |
| **超时只覆盖一次** | 请求 + 读响应体共用一个超时窗口，超时直接 `destroy` socket，不会挂到天荒地老 |

### 实测（夸克，本机 → 上游）

| 场景 | 上游请求数 | 接口往返 |
|------|-----------|---------|
| `check` 有效链接（冷启动） | 2 | ~430ms |
| `check` 有效链接（预热后） | 2 | ~170~200ms |
| `existing` 去重命中 | 5（解析分享 ∥ 列目录 → 建分享 → 取链接） | ~370~570ms |
| 删除（含 2 次任务轮询） | 3 | **784ms → 344ms** |
| **`save`（去重 + 转存 + 自动分享）** | **13（7 个业务请求 + 6 次轮询）** | **3041ms → 1248ms** |

界面底部的耗时条会同时给出「接口往返」和「各步累计」——注意**各步累计在并行步骤上会重复计算**，
看体感请以「接口往返」为准。

### 排查慢在哪

服务端每个接口都打一行日志，上游慢在哪一步看这一行就够了：

```
[api] POST /api/save 1248ms · 列目录=97ms 取分享令牌=99ms 读分享详情=75ms 转存=111ms
      等待任务=50ms 轮询等待=100ms 等待任务=50ms 轮询等待=100ms
      等待任务=52ms 轮询等待=97ms 等待任务=63ms 列目录=122ms
      创建分享=59ms 等待任务=49ms 轮询等待=101ms 等待任务=51ms 取分享链接=56ms
```

**这行日志的教训**：优化前各步之和只有 1393ms，总耗时却是 3041ms —— 差的 1.6s 是轮询
`delay()` 的等待，当时没有记录，完全看不出来。现在等待也记进 trace（步骤名「轮询等待」），
各步之和与总耗时可以对上。

`WANGPAN_LOG=0` 可关掉。

### save 的 1.25s 花在哪（以及为什么基本到顶了）

| 部分 | 耗时 | 能否再省 |
|------|------|---------|
| 7 个业务请求（解析分享 ×2、列目录 ×2、转存、建分享、取链接） | ~620ms | 见下 |
| 等夸克执行两个异步任务（转存 + 建分享） | ~713ms | **不能**，是上游服务端执行时间 |

两个任务的等待占了 **57%**：转存任务本身要跑 ~350ms，建分享任务 ~100ms。我们能做的只是
"别比它更慢地发现它完成了"——理论下限是 ~1.08s，现在 1.25s，**只剩约 15% 的余量**。

### 还能再快吗

- **夸克分享链接无法用 `share_id` 拼出来**：实测 `share_id` 是 32 位十六进制，而链接路径是另一串
  12 位十六进制（如 `50f6bad9…` → `/s/4d717c13c836`），所以「取分享链接」这一步省不掉。
- **转存后能否省掉"列目录"（~120ms）**：夸克的 task 响应里可能有 `save_as.save_as_top_fids`，
  若稳定返回新 fid 就能省掉一次列目录。目前没做——没有可稳定复现的第三方分享可验证
  （自己的分享不允许转存，返回 41017），猜错会导致分享到错误的文件，风险大于收益。
- **轮询间隔再压到 100ms**：只省约 100ms，却把轮询请求数翻倍，不划算。
- **"先存一部分→立即分享→后台补"**（见上文「分享是活链接」）：转存本身只要 111ms，
  慢的从来不是转存，收益很小却要承担"链接早期内容不全"的风险。没有实现。
- 剩下的主要是**上游服务端执行时间**，本地控制不了。

---

## 已知限制

- **未用真实账号验证**：代码按公开的 Web 接口协议实现。链接解析、去重比对、连接池/超时行为
  有离线自测覆盖；**夸克侧的连通性已用真实账号实测通过**（check / existing / delete），
  **百度侧仍需你用自己的 Cookie 实测**（`ping` → `check` → `save` 逐步验证）。
- **非官方接口**：夸克无公开 API，百度走的是 Web 接口；官方改版会失效，需要跟着调整。
- **风控**：百度单账号每日创建分享上限约 300 个，转存建议每次间隔 ≥ 1 秒；批量操作易触发风控。
- **去重是启发式**：夸克按"文件名 + 大小"，百度优先 md5、退化到"文件名 + 大小"，
  同名不同内容或内容相同但改名的情况会误判。且只比对目标目录这一层，不递归。
- **不能转存自己的分享**：夸克返回 `41017`，用「检测已有」替代。
- **删除逻辑**：按"自己的分享链接"删除时，依赖分享内条目 id 与你网盘内 id 一致
  （自己的分享成立，转存来的第三方分享不成立）。
- 转存目标目录：夸克用目录 fid，百度用目录路径字符串。
- **超时保护**：请求与读响应体共用同一个超时窗口（`WANGPAN_TIMEOUT_MS`，默认 30s）。
  上游返回响应头后 body 迟迟不结束时也能在超时后失败，不会无限挂起。
- **保活连接池**：空闲连接默认保留 60 秒。若复用到了已被上游关闭的连接，
  会针对 `ECONNRESET`/`EPIPE` 自动重试一次（仅在"复用了旧连接且一个字节响应都没收到"时，
  不会造成重复执行）。

---

## 目录结构

```text
src/
  server.js            本地 Web 服务（界面后端 + HTTP 接口）
  index.js             统一工作流（check / save / dedup / delete）
  lib/util.js          Cookie、连接池 HTTP 请求、延时、格式化、错误类型
  providers/quark.js   夸克实现
  providers/baidu.js   百度实现
public/                图形界面（index.html / style.css / app.js）
test/parse.test.js     离线自测：链接解析、去重比对、Cookie（无网络）
test/http.test.js      离线自测：连接池复用、超时、HeaderBag（本机临时 server）
docs/cloud-drive-research.md   各网盘接入能力调研
```
