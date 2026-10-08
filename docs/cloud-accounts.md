# 网盘账号管理

## 支持范围与入口

后台 `/admin/cloud-accounts` 管理 `baidu`、`quark`、`aliyun`、`xunlei`、`guangya`。百度、夸克使用 Cookie；阿里、光鸭使用 Token 并支持凭证维护；迅雷使用高级导入，不能假设所有平台都支持相同扫码协议。

账号授权、凭证维护和资源交付是独立职责：关闭采集或链接后台任务不等于关闭凭证维护。启动模式及 `PANSOU_AUTH_WORKER_ENABLED` 以 [main.rs](../src/main.rs) 为准。

## 管理 API

以下路径均以 `/api` 为前缀，要求管理员权限：

| 方法与路径 | 职责 |
| --- | --- |
| `GET /admin/cloud-accounts` | 获取账号状态 |
| `POST /admin/cloud-accounts/{provider}/login-sessions` | 创建授权会话 |
| `GET /admin/cloud-accounts/{provider}/login-sessions/{id}` | 获取授权进度 |
| `DELETE /admin/cloud-accounts/{provider}/login-sessions/{id}` | 取消授权会话 |
| `POST /admin/cloud-accounts/{provider}/import` | 高级导入凭证 |
| `POST /admin/cloud-accounts/{provider}/check` | 检查账号 |
| `DELETE /admin/cloud-accounts/{provider}/connection` | 断开账号 |

连接和导入请求包含 `intent`、`expectedEpoch`，断开请求包含 `expectedEpoch`；更新必须与当前绑定版本一致。授权会话还绑定管理员身份。响应禁止缓存，账号写接口检查请求来源。具体字段和错误处理见 [cloud_accounts.rs](../src/handlers/cloud_accounts.rs)。

## 凭证存储与部署边界

- 凭证直接存储在 PostgreSQL `cloud_account_settings`，不是由本地密钥文件解密读取。
- 数据库及备份包含可直接使用的凭证，应限制访问、保护备份并避免将凭证写入日志或前端状态。
- 绑定版本、Token 版本和数据库租约防止账号切换期间旧任务覆盖新凭证；租约不代替数据库访问控制。
- 阿里、光鸭令牌续期与百度、夸克 Cookie 检查由凭证 Worker 处理，上游行为变化仍可能需要重新授权。
- 请求主机由后端固定；Token 凭证不允许配置任意 API 地址或请求头。

迁移说明见 [migrations/README.md](../migrations/README.md)。旧版凭证升级必须按实际库版本验证，不能把开发者本地已经完成的升级当作其他环境的保证。

账号配置和资源交付策略分别维护，交付、检测与清理说明见 [网盘交付与清理](cloud-drive-providers.md)。
