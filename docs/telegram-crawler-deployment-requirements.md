# Telegram 频道资源抓取系统需求与部署文档

## 1. 文档目的

在另一台 Linux 服务器上部署一套独立的 Telegram 公开频道资源抓取系统，将频道中的网盘资源解析后写入 MySQL，并提供远程监控面板。

本系统与业务主站解耦，抓取程序、数据库和监控面板全部运行在远程服务器上。

## 2. 当前业务范围

### 2.1 抓取来源

当前配置 10 个 Telegram 频道，原 11 个频道中的 `lsp115` 已停抓；其历史资源仍保留在数据库中。来源统一使用公开页面：

```text
https://t.me/s/{channel}
```

当前频道包括以下 10 个完整地址：

| 来源 ID | Telegram 页面 |
| --- | --- |
| `leoziyuan` | `https://t.me/s/leoziyuan` |
| `aliyun_4k_movies` | `https://t.me/s/aliyun_4k_movies` |
| `bdwpzhpd` | `https://t.me/s/bdwpzhpd` |
| `quark_movies` | `https://t.me/s/quark_movies` |
| `sharealiyun` | `https://t.me/s/sharealiyun` |
| `ucquark` | `https://t.me/s/ucquark` |
| `xx123pan` | `https://t.me/s/xx123pan` |
| `tgsearchers7` | `https://t.me/s/tgsearchers7` |
| `tgbokee` | `https://t.me/s/tgbokee` |
| `yunpanx` | `https://t.me/s/yunpanx` |

频道必须通过配置文件维护，不应把频道列表硬编码在业务代码中。新增频道时，只需新增来源配置和对应的 `transform` 函数。

### 2.2 解析规则

每个频道拥有独立的 `transform(payload, $, context)` 函数，用于解析 Telegram HTML。解析结果至少包含：

- 资源名称 `name`
- 资源描述 `description`
- Telegram 消息时间 `datetime`
- 网盘链接 `links`
- 资源图片 `images`
- 资源唯一标识 `id`

解析必须过滤频道发帖人的头像，不能把以下元素写入资源图片：

```css
.tgme_widget_message_user_photo
.tgme_widget_message_author_photo
[class*="avatar"]
```

资源图片只允许来自资源消息本身的图片或背景图。

## 3. 系统架构

```text
Telegram t.me/s 页面
        │
        ▼
Node.js Telegram Crawler
  ├─ 频道配置 sources.json
  ├─ 每频道 transform 函数
  ├─ 直连 / 代理 fallback
  ├─ 并发 worker
  ├─ 断点游标
  └─ MySQL 事务写入
        │
        ▼
MySQL pansou 数据库
        │
        ▼
Node.js Dashboard :8080
```

抓取服务和面板服务分别由 systemd 管理，抓取服务异常退出后自动重启。

## 4. 服务器和依赖要求

### 4.1 操作系统

- Debian 11/12 或 Ubuntu 22.04+
- root 或具备 Docker、systemd 管理权限的部署用户
- 建议至少 4 vCPU、8 GB 内存
- 根据频道历史规模准备足够磁盘空间，建议至少 50 GB

### 4.2 软件依赖

- Docker Engine
- MySQL 8.x，建议运行在 Docker 中
- Node.js 20+
- npm
- systemd

## 5. MySQL 部署要求

### 5.1 持久化

MySQL 必须使用持久化卷，不能使用容器临时文件系统：

```text
mysql_data:/var/lib/mysql
```

字符集必须为 `utf8mb4`，排序规则建议使用 `utf8mb4_unicode_ci`。

### 5.2 数据库配置

以下内容必须通过环境变量注入，不能写死在代码中：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=pansou
MYSQL_USER=pansou
MYSQL_PASSWORD=<strong-random-password>
MYSQL_CONNECTION_LIMIT=12
```

如果需要公网访问 MySQL：

- 服务器开放 TCP 3306
- MySQL 用户允许远程来源连接
- 防火墙尽量限制来源 IP
- 禁止使用 root 账户远程登录
- 密码必须使用随机高强度密码

### 5.3 数据表

抓取程序启动时自动创建以下表。

#### `pansou_resources`

资源主表，字段包括：

- `id`：资源唯一 ID，主键
- `source_id`：频道来源 ID
- `telegram_message_id`：Telegram 消息 ID
- `name`：资源名称
- `description`：资源描述
- `datetime_text`：频道消息时间
- `cloud_types_json`：资源包含的网盘类型
- `tags_json`：标签数组
- `images_json`：资源图片数组
- `enabled`：启用状态
- `created_at`
- `updated_at`

#### `pansou_resource_links`

网盘链接明细表，采用拍平设计，一条网盘链接一行：

- `resource_id`
- `position_no`
- `type`：例如 `quark`、`baidu`、`aliyun`、`115`、`magnet`
- `url`：去除提取码参数后的标准链接
- `password`：提取码
- `original_url`：原始链接
- `url_hash`：链接去重哈希
- `created_at`
- `updated_at`

同一个资源可有多个网盘链接，不能只保留一个链接字段。

#### `pansou_crawl_state`

每个频道一行，用于断点续抓：

- `source_id`
- `phase`：`pending`、`full`、`complete`、`failed`
- `next_before`：下一页 Telegram 游标
- `high_watermark`：已见最大消息 ID
- `pages`：已处理页数
- `resources`：已解析资源数
- `last_error`
- `updated_at`
- `completed_at`

#### `pansou_crawl_pages`

页面处理记录，用于审计、去重和恢复：

- `source_id`
- `before_cursor`
- `min_post_id`
- `max_post_id`
- `result_count`
- `fetched_at`

## 6. 抓取策略

### 6.1 全量抓取

- 从频道最新页开始抓取
- 通过 Telegram 页面中的 `data-before` 或上一页链接获取游标
- 每页成功解析并写入数据库后，才更新 `next_before`
- 页面写入必须使用事务
- 当前页失败时，不能推进游标
- 服务重启后从数据库中的游标继续
- 已完成频道状态为 `complete`，不得重复全量回填

### 6.2 并发

并发是“频道级并发”，每个频道内部仍按游标顺序逐页抓取。

```env
PAGE_DELAY_MS=0
CRAWL_CONCURRENCY=10
```

`CRAWL_CONCURRENCY` 是频道级并发数，即同时抓取多少个频道，不是单频道页并发。当前远程面板支持直接修改该配置并重启抓取服务；当频道数少于配置并发数时，实际 worker 数量不得超过频道数量。

单频道页面由于 Telegram `before` 游标必须由上一页返回，目前保持顺序抓取，不能安全地同时请求 12 页。

### 6.3 增量抓取

所有频道全量完成后，每 3 分钟执行一次增量扫描：

```env
INCREMENT_INTERVAL_MS=180000
```

增量模式从最新页开始，遇到已知 `high_watermark` 后停止，不应重新扫描整个历史频道。

### 6.4 请求超时和 fallback

默认请求参数：

```env
REQUEST_TIMEOUT_MS=45000
MAX_RESPONSE_BYTES=8388608
```

请求顺序：

1. Telegram 直连
2. 代理节点 1
3. 代理节点 2
4. 其他代理节点

当前部署使用的代理地址：

| 代理 ID | 类型 | Base URL |
| --- | --- | --- |
| `direct` | 直连 | 无，直接请求 Telegram |
| `tencent-edge-1` | 腾讯云 Edge | `https://worker-dpibnfsss1q4.edgeone.dev` |
| `tencent-edge-2` | 腾讯 Edge 国内 | `https://proxy-ururfjd5.edgeone.dev` |
| `worker-frosty-mouse` | Cloudflare Worker | `https://frosty-mouse-58c9.691736657.workers.dev` |
| `worker-wild-glade` | Cloudflare Worker | `https://wild-glade-8d69.mr-songjintao.workers.dev` |

请求顺序是先直连，再按上表顺序依次尝试代理。代理地址属于当前环境配置，迁移到另一台机器时必须确认这些地址仍然可用；如果更换代理，只需要修改 `sources.json` 中的 `proxies` 数组。

代理配置示例：

```json
{
  "id": "tencent-edge-1",
  "name": "腾讯云 Edge",
  "baseUrl": "https://your-proxy.example.com"
}
```

代理收到目标地址后，应通过 URL 编码参数转发。所有请求必须校验返回内容确实包含对应频道的 Telegram 消息结构。

### 6.5 数据库写入重试

并发写入可能出现 InnoDB 死锁或锁等待超时。以下错误必须自动重试：

- `ER_LOCK_DEADLOCK`
- `ER_LOCK_WAIT_TIMEOUT`

建议最多重试 5 次，使用指数退避，例如：

```text
250ms → 500ms → 1000ms → 2000ms
```

达到最大重试次数后，记录频道错误并保留当前断点，不能删除已成功写入的数据。

## 7. 链接规范化

链接解析要求：

- 支持百度、夸克、阿里、115、123、迅雷、UC、天翼、移动、坚果、蓝奏等网盘
- 支持 `magnet:` 和 `ed2k:`
- 从 URL 查询参数中提取 `pwd`、`password`、`pass`、`code`、`extract_code`
- `url` 中删除提取码参数并保留干净链接
- `password` 单独保存
- 同一资源内按 `type + url` 去重
- 保留原始链接到 `original_url`

## 8. 监控面板

### 8.1 部署位置

监控面板必须部署在抓取服务器，不加入业务主站前端。

默认监听：

```text
0.0.0.0:8080
```

### 8.2 认证

使用 HTTP Basic Auth：

```env
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<dashboard-password>
```

密码不得硬编码在源码中。

### 8.3 页面功能

面板必须展示：

- 总资源数
- 已完成频道数
- 正在全量抓取的频道数
- 错误频道数
- 每个频道的资源数、页数、抓取状态和进度
- 最新资源卡片
- 资源所属频道
- 资源名称、描述、图片
- 网盘名称
- 完整网盘链接
- 打开链接按钮
- 复制链接按钮
- 提取码
- 频道筛选
- 资源名称搜索
- 分页
- 自动刷新

### 8.4 进度计算

Telegram 页面没有可靠的总页数，因此未完成频道的百分比只能作为估算值：

- `pending`：0%
- `complete`：100%
- 其他状态：基于当前游标或明确总量的估算
- 未完成状态不得显示 100%
- 页面必须标注“估算”

频道真正完成的唯一依据是数据库 `phase=complete`。

### 8.5 运行配置

面板提供运行配置区域，可修改并立即重启抓取服务：

- 频道并发数：`CRAWL_CONCURRENCY`，范围 1-32
- 页面间隔：`PAGE_DELAY_MS`，可配置为 0 秒
- 单频道页并发：当前固定为 1，避免游标链并发造成漏抓

页面间隔设置为 0 后不再主动等待 3 秒，但仍会受到网络响应时间、代理切换和 Telegram 服务端响应速度影响。

### 8.6 接口

健康检查：

```text
GET /healthz
```

数据接口：

```text
GET /api/snapshot?page=1&source=<source_id>&q=<keyword>
```

运行配置接口：

```text
GET /api/settings
POST /api/settings
```

接口必须使用与页面相同的 Basic Auth。

## 9. 环境变量模板

抓取服务 `.env`：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=pansou
MYSQL_USER=pansou
MYSQL_PASSWORD=<mysql-password>
MYSQL_CONNECTION_LIMIT=12

CRAWLER_CONFIG=/opt/telegram-crawler/sources.json
PAGE_DELAY_MS=0
CRAWL_CONCURRENCY=10
INCREMENT_INTERVAL_MS=180000
REQUEST_TIMEOUT_MS=45000
MAX_RESPONSE_BYTES=8388608
```

面板 `.env`：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=pansou
MYSQL_USER=pansou
MYSQL_PASSWORD=<mysql-password>
CRAWLER_CONFIG=/opt/telegram-crawler/sources.json
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=8080
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<dashboard-password>
```

`.env` 权限必须为 `0600`。

## 10. systemd 服务

### 10.1 抓取服务

服务名建议：

```text
pansou-telegram-crawler.service
```

要求：

- `WorkingDirectory` 指向抓取目录
- `ExecStart` 使用 Node.js 20+ 执行 `index.mjs`
- `EnvironmentFile` 指向抓取服务 `.env`
- `Restart=always`
- `RestartSec=15`
- 正常停止时等待当前页面完成或安全退出

### 10.2 面板服务

服务名建议：

```text
pansou-telegram-dashboard.service
```

要求：

- 使用 Node.js 启动 `dashboard.mjs`
- `EnvironmentFile` 指向面板 `.env`
- `Restart=always`
- 监听 `0.0.0.0:8080`

## 11. 推荐部署目录

```text
/opt/telegram-crawler/
├── index.mjs
├── dashboard.mjs
├── sources.json
├── package.json
├── package-lock.json
├── .env
├── dashboard.env
└── node_modules/
```

数据库数据由 Docker volume 单独保存，不放在代码目录中。

## 12. 部署步骤

1. 安装 Docker、Node.js 20+ 和 npm。
2. 创建 MySQL 容器及持久化卷。
3. 创建 `pansou` 数据库和专用用户。
4. 上传抓取程序、面板程序、`sources.json` 和 package 文件。
5. 执行 `npm ci`。
6. 创建 `.env`、`dashboard.env`，填入新机器的密码和路径。
7. 安装并启动两个 systemd 服务。
8. 检查服务状态和日志。
9. 登录面板确认 10 个活动频道都已出现。
10. 验证数据库断点、资源链接和图片过滤。

## 13. 验收标准

### 基础运行

- `systemctl is-active pansou-telegram-crawler.service` 返回 `active`
- `systemctl is-active pansou-telegram-dashboard.service` 返回 `active`
- `GET /healthz` 返回 `{"ok":true}`
- 面板 Basic Auth 生效

### 抓取正确性

- 当前配置的 10 个频道均出现在 `pansou_crawl_state`
- 每个频道的 `phase`、`pages`、`resources` 持续更新
- 直连失败后能自动切换代理
- 数据库死锁不会导致数据丢失
- 重启服务后能从 `next_before` 继续
- 同一消息重复抓取不会产生重复资源

### 数据正确性

- 资源名称和描述正确
- 网盘链接被拍平到 `pansou_resource_links`
- 网盘名称、URL 和提取码可在面板显示
- 资源卡的图片中不包含发帖人头像
- 资源链接可以打开和复制

### 增量同步

- 全量完成后每 3 分钟执行一次增量同步
- 新 Telegram 消息可以写入数据库
- 增量同步不会重扫完整历史频道

## 14. 常用检查命令

```bash
systemctl status pansou-telegram-crawler.service
systemctl status pansou-telegram-dashboard.service

journalctl -u pansou-telegram-crawler.service -f
journalctl -u pansou-telegram-dashboard.service -f

docker ps
docker logs mysql --tail 100
```

数据库数量必须使用精确 SQL 查询，不要只看管理工具表列表中的“行”列：

```sql
SELECT COUNT(*) FROM pansou_resources;
SELECT COUNT(*) FROM pansou_resource_links;
SELECT COUNT(*) FROM pansou_crawl_pages;
SELECT COUNT(*) FROM pansou_crawl_state;
SELECT source_id, phase, pages, resources, next_before, last_error
FROM pansou_crawl_state
ORDER BY source_id;
```

## 15. 后续维护要求

- 新增频道优先通过 `sources.json` 添加
- 每个新频道提供独立 transform
- 不把抓取面板代码加入业务主站
- 不把密码、代理密钥或数据库凭据提交到 Git
- 修改抓取逻辑前先备份 `sources.json` 和数据库
- 修改并发数后至少观察 5～10 分钟，确认无连续 fallback、死锁或服务重启
- 任何破坏性数据库操作前必须先备份
