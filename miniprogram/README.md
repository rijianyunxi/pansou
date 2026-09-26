# 盘搜微信小程序

原生微信小程序（无构建工具，CommonJS），对接 PanHub 后端的 SSE 流式搜索。全程使用 Bearer token 会话（`POST /api/account/wechat/login` code2Session 静默登录，首登自动建号），不依赖 Cookie。

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss   启动静默登录、TabBar（搜索/我的）、设计变量（网页 classic 主题移植）
  utils/
    config.js        API_BASE（默认 https://pan.letus.lol，需与微信后台合法域名一致）
    auth.js          wx.request 封装、静默登录 ensureLogin、token 过期管理
    api.js           session/热搜/频道 CRUD/validate，401 清 token 重登重试一次
    searchStream.js  SSE 流式搜索：wx.request enableChunked + onChunkReceived +
                     流式 UTF-8 解码（处理跨块多字节截断）+ SSE 事件解析
    resultMerge.js   按链接 URL 合并（并查集，移植 server/core/utils/resultMerge.ts）
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

1. `miniprogram/project.config.json` 中填入自己的 `appid`（当前为占位 `touristappid`，游客模式无法真机预览）。
2. 微信开发者工具导入本目录（项目根选 `miniprogram/`）。
3. 基础库需 **≥ 2.20.1**（`enableChunked` 流式请求依赖），详情 → 本地设置 → 调试基础库选择。
4. 开发阶段可在「详情 → 本地设置」勾选「不校验合法域名」直连；线上需在小程序后台把
   `https://pan.letus.lol` 配置为 **request 合法域名**。
5. 修改 `utils/config.js` 的 `API_BASE` 可切换后端（本地后端跑 `npm run dev`，注意 Nitro 会跳过 6666 端口改用 3001）。

## 服务端依赖

- `POST /api/account/wechat/login`：需在管理后台配置小程序 AppID/Secret（`/api/settings/wechat`）。
- `POST /api/search`（SSE）、`GET /api/hot-searches`、`GET /api/account/session`、
  `/api/account/channels*` 均已就绪，服务端无需改动
  （小程序 `wx.request` 不发送 Origin 头，不受同源校验影响）。

## 行为说明

- **登录**：启动时静默 `wx.login`，用户无感知；登录失败仍可匿名搜索（服务端一次性匿名会话，限流按 IP）。
- **搜索**：SSE 按来源流式返回，客户端按链接合并去重（与服务端同规则）；结果>30 条分页渲染。
- **打开链接**：第三方网盘域名无法加入 web-view 业务域名白名单，故「打开链接/复制」均为复制到剪贴板，
  前者额外提示去浏览器打开；磁力链接同样复制。复制和打开不会向服务端提交资源收录请求。
- **暂停/继续**：暂停即中断流并保留已收结果；继续会重新发起搜索（服务端有缓存，通常很快返回）。
- **token 过期**：请求前检查 `expiresAt`，401 时清除本地会话、静默重登并重试一次。
