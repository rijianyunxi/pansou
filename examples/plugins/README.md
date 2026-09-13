# Instructions 插件示例

本目录提供 3 个可直接导入的声明式 Instructions 插件定义（JSON），全部通过
`server/core/instructions/validator.ts` 的 schema 与安全校验（校验见
`test/unit/pluginExamples.test.ts`）：

| 文件 | 演示内容 |
|---|---|
| `json-basic.json` | JSON API 基础接入：GET + query 变量插值、点路径字段映射、受限正则提取提取码、页码参数分页 |
| `html-selector.json` | HTML 搜索页：CSS selector 字段映射、`href`/`data-*` 属性提取、常量链接类型、下一页 selector 翻页 |
| `multi-stage.json` | 多阶段请求：前置阶段提取 token/buildId/sign 变量、密钥注入请求头、阶段同域白名单 |

所有上游地址均为 `example.com` 类占位域名，导入后请替换为真实上游。

## 导入方式

1. 管理台导入：登录 `/admin?view=sources`（需独立 `ADMIN_PASSWORD`），使用「导入」功能上传单个或多个 JSON 定义；导入后保存为草稿。
2. API 导入：`POST /api/plugins/import`，请求体为 `{"definitions": [<definition>, ...]}`（单次最多 100 个），需携带管理员 Cookie（先 `POST /api/auth/admin-unlock`）。
3. 手工创建：在 `/admin?view=sources` 编辑器中按定义填写各字段保存。

导入只是保存草稿；参与正式搜索前必须完成一次样本解析验证并发布（`POST /api/plugins/:id/validate` → `POST /api/plugins/:id/publish`）。字段语义与安全边界见 `TODO.md` 第 6.8、6.9 节。
