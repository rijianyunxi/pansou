# 资源源请求代理与中转方案

状态：设计方案，尚未实现。本文中的配置字段和接口均为拟议设计，当前生产构建不包含代理功能。

## 目标与范围

资源源保留原始 URL、请求参数及 transform，通过单独的请求线路配置选择直连或中转。搜索、资源源测试和健康探测使用相同的线路解析逻辑；用户频道模板生成的资源源也能使用该配置。

第一阶段优先支持自建 Cloudflare Worker HTTP 中转；Jina Reader 作为独立的网页读取适配器。暂不加入代理池轮换、自动重试或失败后自动转直连，保留现有每源单次执行的行为。

## 三种线路的区别

| 类型 | 工作方式 | 适用场景 |
| --- | --- | --- |
| 直连 | 后端直接请求目标网站，并绑定已验证的目标 IP | 默认线路 |
| HTTP 中转 | 后端请求 Worker 等服务，由中转访问目标网站并返回响应 | JSON API、GET/POST 接口、HTML 页面 |
| Jina Reader | 后端调用 Reader，由 Reader 抓取、渲染或转换页面 | 需要网页内容提取或页面渲染的资源源 |

HTTP/HTTPS CONNECT 和 SOCKS 代理属于连接层代理，可以后续单独扩展；HTTP 中转和 Jina 不使用这套连接协议。

## 配置模型

后台集中管理线路配置，资源源只引用线路 ID，不把密钥复制到每份资源源或公开导出的模板中。

拟议的源配置：

```json
{
  "routing": {
    "mode": "relay",
    "relayId": "worker-main"
  }
}
```

`mode` 可选 `inherit`、`direct`、`relay`；`relayId` 引用具有 `worker` 或 `jina` 类型的线路。全局默认直连，旧数据缺少配置时继承默认，源可显式指定直连。

线路配置包含：名称、类型、入口 URL、启用状态、认证引用、配置版本，以及适配器专用选项。服务端保存认证信息，后台读取时脱敏，日志不记录密钥。自定义入口只能由管理员配置。

源的请求头与中转服务的认证头分别管理，不能合并后全部透传。禁用或不存在的指定线路应明确报错，不能悄悄回退为直连。

## 请求处理流程

1. 按原有源定义生成完整目标请求，包括关键词、分页参数、请求头和请求体。
2. 校验原始目标 URL 和源的域名白名单，确定有效线路。
3. 直连走现有安全 HTTP 执行器；中转由适配器构造独立的外层请求。
4. 对外层中转 URL 使用单独的受信入口配置，并经过现有出站 URL/DNS 检查。
5. 适配器将返回内容转换成统一的响应结构，再交给原有 JSON/HTML 解析和 transform。
6. transform 的源 URL、相对链接解析基址使用原目标地址；若支持目标重定向，则使用经过校验的最终目标地址。

必须先生成完整目标 URL，再进行 URL 编码或拼接，避免把搜索参数错误追加到中转服务本身。

## Cloudflare Worker 中转

推荐先定义并实现一个明确的中转协议，而不是假设所有现成 Worker 都支持相同格式。

示例接口：

```text
https://relay.example.com/fetch?url=<encodeURIComponent(完整目标URL)>
```

请求约定：

- 第一版支持 GET、POST，外层请求方式与目标请求一致，POST 请求体按原始字节转发。
- 使用单独的中转认证头，例如 `X-Relay-Token`。Worker 验证后移除此头，绝不转发给目标。
- 目标请求头按明确白名单转发；目标站 Authorization 与中转认证分别处理。
- Host 由目标 URL 决定，不转发客户端 Host、连接专用头和不可信的转发 IP 头。
- 默认不缓存搜索响应，避免关键词、用户身份或认证差异造成错误复用。

响应约定：

- 保留目标站状态码、有效的 Content-Type 和响应内容，不对业务 JSON/HTML做内容提取。
- 若运行时解压或重新编码响应，必须同步处理 Content-Encoding 和 Content-Length，避免头与正文不一致。
- 中转错误使用独立、可识别的错误标记；目标站同名标记应剥离，避免与中转故障混淆。
- 第一版不自动跟随目标重定向。支持重定向前，应定义最终目标 URL 和每跳状态的传递协议，由 Worker 逐跳检查域名及次数；不能把原目标 Location 交给后端当成中转入口的重定向。
- 限制请求体、响应体、耗时和并发；后端的取消、总超时和大小限制继续生效，Worker 自身也要有独立执行上限。

Worker 使用 fetch 并不等于浏览器渲染，也不能保证目标网站接受 Cloudflare 出口 IP。上线前需要用实际资源源验证 GET、POST、认证、HTML 和 JSON 响应。

## Jina Reader 适配器

GET 网页读取示例：

```text
原始地址：https://example.com/search?q=keyword
读取地址：https://r.jina.ai/https://example.com/search?q=keyword
```

Reader 是内容读取服务，其结果不是通用的源站原始 HTTP 响应：

- 普通文本输出包含 Reader 的内容转换，不能直接交给现有 HTML 选择器。
- 可通过 `X-Respond-With: html` 请求页面 DOM，但不保证与原始响应 HTML 一致。
- `Accept: application/json` 返回 Reader 的 JSON 包装，不代表透传源站 JSON API。适配器需要验证成功状态并解包内容后再调用 transform。
- 向 Reader 发 POST 可以用于提交 Reader 的读取参数，不能视为任意目标 POST 接口的透明转发。
- 第一版只接入 GET 网页源；不兼容的 POST/JSON API 源在保存或诊断时给出明确提示。
- 需要逐源验证链接、列表、日期和隐藏数据是否保留；Reader 返回 HTML 的实际 Content-Type 和包装方式由适配器处理。
- API Key 只发送给 Reader，不直接透传源站 Cookie/Authorization。后续确需支持认证页面时再做明确映射。
- 配置超时和缓存策略，并处理服务限流；具体额度以服务端当前账户为准，不在代码里假设固定额度。

优先尝试 HTML 模式复用现有 transform。若需要 Markdown/文本模式，应显式扩展响应格式和解析契约，不能将纯文本伪装成 HTML。

## 安全边界

现有直连链路先检查目标 DNS，再把连接固定到验证后的公网 IP。HTTP 中转后，后端只能固定连接到中转服务器，无法保证中转服务到目标站这一段沿用同一个解析结果。

- 原目标白名单与中转入口白名单分别检查，不能通过放宽一个白名单解决两层请求。
- 自建 Worker 使用固定的允许目标域名列表、HTTPS 和允许端口限制，并禁止任意目标及未经检查的重定向。
- Workers fetch 的 DNS 行为不等同于现有 Node socket 绑定，不能声称端到端保留相同的 DNS 固定能力。
- 使用 Jina 时信任其目标抓取、DNS 和重定向行为。若某些源要求严格端到端 IP 固定，应使用直连或另行实现 CONNECT 代理。
- 日志区分原目标与中转入口，并对查询串、认证头及响应中的敏感信息脱敏。

## 项目改动位置

| 位置 | 拟议改动 |
| --- | --- |
| `types/source.ts` | 增加源线路引用及诊断字段 |
| `server/core/source-runtime/types.ts`、`validation.ts` | 增加运行时线路结构与兼容性校验 |
| `server/core/services/configuredSource.ts` | 传递线路配置，纳入配置版本计算 |
| `server/core/source-runtime/executor.ts` | 在完整请求生成后选择适配器，保留原始源上下文 |
| `server/core/http/` | 增加中转适配器；继续复用安全请求、取消和响应限制逻辑 |
| `server/core/storage/`、`services/` | 线路配置持久化、密钥引用和有效线路解析 |
| 后台资源源与模板编辑器 | 选择线路，检查能力兼容性，提供线路诊断 |
| 健康状态与缓存 | 线路或线路版本改变后避免复用旧诊断、旧结果 |

共享中转配置变化也应改变有效请求版本，避免只修改中转配置却继续使用旧缓存。用户频道可用性校验与实际搜索也需要明确并统一有效线路选择。

## 实施顺序与验收

1. 实现线路配置和自建 Worker 协议，直连保持原有默认行为。
2. 接通搜索、后台源测试、模板和诊断；验证 JSON GET、JSON POST 与 HTML 源的结果一致性。
3. 增加 Jina 专用适配器，用实际网页源验证 HTML 和包装响应的解析。
4. 覆盖认证隔离、参数编码、相对链接、重定向、取消、超时、响应超限及线路禁用等测试。
5. 确认失败不自动重试或转直连，并验证配置变更后缓存和健康状态刷新。

## 参考文档

- [Jina Reader](https://github.com/jina-ai/reader/blob/main/README.md)
- [Cloudflare Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Cloudflare Workers Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Workers Response](https://developers.cloudflare.com/workers/runtime-apis/response/)
