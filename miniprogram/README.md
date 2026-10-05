# 盘搜微信小程序

原生微信小程序（无构建工具，CommonJS），对接 PanHub 后端的 SSE 流式搜索。全程使用 Bearer token 会话（`POST /api/account/wechat/login` code2Session 静默登录，首登自动建号），不依赖 Cookie。

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss   启动静默登录、TabBar（搜索/我的）、设计变量（网页 classic 主题移植）
  utils/
    config.js        API_BASE（默认 https://pan.letus.lol，需与微信后台合法域名一致）
    auth.js          wx.request 封装、静默登录 ensureLogin、token 过期管理
    api.js           复用登录态和配置/热搜/频道 CRUD/validate，401 清 token 重登重试一次
    searchStream.js  SSE 流式搜索：wx.request enableChunked + onChunkReceived +
                     流式 UTF-8 解码（处理跨块多字节截断）+ SSE 事件解析
    resultMerge.js   按服务端 dedupKey 合并完整链接集合，保留最新 resultRef/linkRef
    cloudTypes.js    网盘类型中文标签/图标
    format.js        日期解析（显式 +08:00）与时间排序
  components/resource-card/    资源卡片（标题/描述展开/网盘标签/链接行：打开链接=复制+引导）
  pages/
    index/     搜索首页：热搜、范围切换（本站/自定义频道）、流式结果、平台筛选、时间排序、暂停/继续
    profile/   我的：登录状态、频道管理入口、退出登录
    channels/  自定义频道管理：validate 校验 + 全量保存
    login/     网页扫码登录确认 + 手动登录兜底
  scripts/
    gen_tab_icons.py  TabBar 图标生成（纯 stdlib Python，SDF 抗锯齿）
    test-utils.js     核心逻辑单测（node scripts/test-utils.js）
```

## 开发调试

1. `miniprogram/project.config.json` 中核对自己的 `appid`，需与服务端配置的小程序 AppID 一致。
2. 微信开发者工具导入本目录（项目根选 `miniprogram/`）。
3. 基础库需 **≥ 2.20.1**（`enableChunked` 流式请求依赖），详情 → 本地设置 → 调试基础库选择。
4. 开发阶段可在「详情 → 本地设置」勾选「不校验合法域名」直连；线上需在小程序后台把
   `https://pan.letus.lol` 配置为 **request 合法域名**。
5. 修改 `utils/config.js` 的 `API_BASE` 可切换后端（本地后端运行 `cargo run -- serve`，默认端口 3666）。

## 服务端依赖

- `POST /api/account/wechat/login`：需在管理后台配置小程序 AppID/Secret（`/api/settings/wechat`）；当前线上返回 token、expiresAt 和 user。
- `GET /api/account/session`：携带现有 Bearer token 读取会话及页面配置；没有有效 token 时创建匿名会话。小程序不依赖尚未上线的 `/api/account/config`。
- `POST /api/search`（SSE）、`GET /api/hot-searches`、`/api/account/channels*`、
  `POST /api/links/resolve`、`GET /api/links/resolve-operations/{key}` 均已就绪
  （小程序 `wx.request` 不发送 Origin 头，不受同源校验影响）。

## 行为说明

- **登录**：启动时静默 `wx.login`，用户无感知；登录失败仍可匿名搜索（服务端一次性匿名会话，限流按 IP）。
- **初始化**：启动、首页及搜索共用进行中的登录请求。当前线上登录完成后，从 `/api/account/session` 读取配置；若未来登录响应同时携带配置，则直接复用。配置在内存中缓存 60 秒，读取请求合并；退出登录后保持匿名，手动登录可恢复账号。
- **热搜**：默认隐藏，只有成功获取配置且 `showHotSearch=true` 时才请求 `/api/hot-searches`；配置获取失败、缺少开关或开关关闭时不请求。
- **搜索**：SSE 流式返回，客户端按服务端 dedupKey 合并完整链接集合；结果>30 条分页渲染。正常结束时处理最后一个事件，只保留有上限的错误报文，避免重复缓存全部结果。
- **打开/复制**：操作先调用取链接口；打开使用 web-view 跳转，复制只写入可打开的链接，已确认支持的网盘将提取码放入 URL 参数。返回的提取码显示在卡片上，可点击单独复制。过期或失效的提取码不能复制。
  web-view 只能打开配置的合法 HTTPS 业务域名；未获许可的第三方网盘域名和磁力链接会提示使用复制按钮，不会偷偷复制或绕过微信限制。
- **暂停/继续**：暂停即中断流并保留已收结果；继续会重新发起搜索（服务端有缓存，通常很快返回）。
- **token 过期**：请求前检查 `expiresAt`，401 时合并恢复会话并重试一次，微信登录失败仍可回退到匿名会话。旧 token 的迟到 401 不会清除新登录；取链操作绑定原会话，不会自动重登重复转存。
