# 网盘交付、检测与清理

## 职责分离

支持的平台见 [账号管理](cloud-accounts.md)。[cloud_drive](../src/cloud_drive/mod.rs) 负责网盘协议，[link_resolution](../src/link_resolution.rs) 负责搜索引用、会话授权、按需交付、持久化操作状态和后台任务。

搜索返回受会话约束的资源/链接引用。用户复制或打开时才请求真实链接，可能触发原链接检测、复用自产分享或按需转存；不存在默认定时批量转存。关闭转存不会自动取消已有产物的清理，也不等于关闭后台有效性检测。

## 用户链接 API

以下路径均以 `/api` 为前缀：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /links/resolve` | 使用搜索引用请求链接交付 |
| `GET /links/resolve-operations/{key}` | 查询同一操作状态 |
| `POST /links/status` | 查询链接有效性 |
| `POST /resources/status` | 查询资源有效性 |

解析与轮询必须属于当前会话，不能将别人的引用或操作结果直接交付。响应丢失时优先查询原操作，不能生成新的幂等键重做写操作。请求字段及状态流以 [link_resolution.rs](../src/link_resolution.rs) 为准。

## 管理员操作

| 方法与路径（`/api` 前缀） | 用途 |
| --- | --- |
| `POST /admin/cloud-drive/check` | 检测分享 |
| `POST /admin/cloud-drive/save` | 转存并创建分享 |
| `POST /admin/cloud-drive/existing` | 查询已有资源 |
| `POST /admin/cloud-drive/list` | 列出目录 |
| `POST /admin/cloud-drive/ping` | 检查连接 |
| `POST /admin/cloud-drive/delete-preview` | 删除预检 |
| `POST /admin/cloud-drive/delete` | 确认删除 |
| `GET /admin/cloud-drive/operations/{key}` | 查询持久化操作 |
| `GET /admin/link-cleanup` | 清理任务列表 |
| `POST /admin/link-cleanup/{id}/retry` | 重试清理 |
| `POST /admin/link-cleanup/{id}/ignore` | 忽略阻塞清理任务 |

删除需要预检及核对项目专用目录、账号归属与条目，不能凭一个分享链接就任意删除整个云盘。写操作使用持久化 `requestKey`，响应丢失不应自动重做。具体接口见 [cloud_drive handler](../src/handlers/cloud_drive.rs)，路由见 [app.rs](../src/app.rs)。

## 后台与错误边界

- `cloud_provider_policies` 按平台保存按需转存和检测参数；项目专用目录不能选根目录。
- 链接检测、到期清理、派生刷新和凭证维护有独立职责与容量预算。
- 网络、登录、提取码、限流和上游业务失败不能一律判为链接已失效。
- 外部写操作并非数据库事务的一部分；幂等状态、归属核实和未知结果处理仍然必要。
- 适配器文件分页和异步任务确认需要回归验证，不能用小样本单元测试推断真实网盘大目录性能。

当前使用 `044` 基线和 `046–052` 升级脚本；新库与旧库升级方法见 [数据库说明](../migrations/README.md)。不再以旧 `010` 文件说明当前安装方式。
