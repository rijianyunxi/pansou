# 上游 transform 验证报告（2026-09-15）

## 范围与结果

- 当前 SQLite 配置为 50 个启用来源：2 HTTP + 48 Telegram（并非 12 个）。
- 离线模板测试：55 项通过；逐配置回归：2,405 项通过，0 失败。
- 已对全部来源发起真实请求，关键词无结果的 Telegram 再请求近期消息。
- 以下使用各来源实测保存的响应预览重新执行最终版 transform，避免偶发 ECONNRESET 干扰格式验证。预览最多 100,000 字符，不代表频道全部历史消息。
- 有有效资源的响应：32 个；无可解析直链响应：18 个；格式失败：0 个。
- 无直链不等同于全部格式通过：部分频道已改用途、仅通知/广告、提供机器人或中转页，当前单请求 transform 不访问这些二级页面。未擅自停用或删除这些频道。
- 真实请求最新一次的网络错误和计数详见本地 .genflow_tmp/transform-live-report.json；原始响应保存在 .genflow_tmp/transform-live/，不提交频道全文。

## 修复

- Telegram 保留 br/p/div/blockquote 换行，再提取标题；识别名称、资源名称、【标题】、电视剧名、◎译名等格式及 emoji 标题；去除标题中的链接和元数据。
- 保留完整消息到 description；链接去重、密码提取、关键词过滤、多消息隔离均有回归。
- 补齐 123 网盘域名识别和 UC 直链提取（UC 仍按现有 CloudType 合约归 others）。
- 混合盘 page 从字符串改为数字 1；业务错误不再伪装成空结果；读取 update_time 等真实日期字段；移除高亮标签而不插入多余空格。
- 48 个已有 Telegram 配置及混合盘配置已更新至 SQLite；更新前保存本地备份。更新脚本保留自定义 Telegram transform，不批量覆盖未知版本。

## 逐来源真实响应回放

| 来源 | 状态 | 资源数 | 示例标题 / 页面标题 |
|---|---|---:|---|
| hunhepan | passed | 8 | 零基础用python高效做科研课程 |
| nyaa | passed | 67 | [ToonsHub] One Piece EP1178 1080p TVER WEB-DL AAC2.0 H.264 |
| tg-aliyun_4k_movies | passed | 15 | 斗破苍穹 第五季 / 斗破苍穹5 / 斗破苍穹年番 (2022) 4K 臻彩MAX [更新202集] |
| tg-aliyunys | passed | 1 | Fights Break Sphere / 斗破苍穹 / 斗破苍穹电影版 / 电影斗破苍穹 |
| tg-alyp_4k_movies | no-direct-resource | 0 | 全国莞式全套会所 – Telegram |
| tg-alyp_animation | no-direct-resource | 0 | alyp_Animation – Telegram |
| tg-alyp_tv | no-direct-resource | 0 | 搜女引流 • WhatsApp账号 • WS账号 • WS系统 – Telegram |
| tg-baicaozy | passed | 17 | 杀手妈咪 유부녀 킬러 (2026) [1080P] [内封简繁] [更至12集] |
| tg-baiduclouddisk | no-direct-resource | 0 | 百度网盘中转&通知频道 – Telegram |
| tg-bdwpzhpd | passed | 13 | 斗破苍穹 (2017) |
| tg-channel_shares_115 | passed | 10 | 斗破苍穹 年番 (2023) 4K |
| tg-gotopan | passed | 10 | 【更新至 128 】斗破苍穹.年番 (2022) 4K |
| tg-hdhhd21 | passed | 10 | 【电影】斗破苍穹3：[剧情 动作 奇幻][附前2部] |
| tg-ialiyun | no-direct-resource | 0 | iAliyun – Telegram |
| tg-jdjdn1111 | passed | 2 | 《魔童：神鸟破穹（78集）动漫》 |
| tg-leoziyuan | passed | 14 | 斗破苍穹 年番 (2025) WEB-4K 臻彩视听 第210集 |
| tg-lsp115 | no-direct-resource | 0 | 115网盘资源分享频道 – Telegram |
| tg-mcph01 | no-direct-resource | 0 | 莫愁片海🐳综合 – Telegram |
| tg-mcph086 | no-direct-resource | 0 | 莫愁片海🐳动画 – Telegram |
| tg-newquark | no-direct-resource | 0 | NewQuark – Telegram |
| tg-oneonefivewpfx | no-direct-resource | 0 | 115网盘资源收藏 – Telegram |
| tg-oscar_4kmovies | no-direct-resource | 0 | 奥斯卡4K蓝光(精品)影视磁力站🍟 – Telegram |
| tg-panjclub | passed | 2 | 斗破苍穹4：逃亡 电影版4K [60帧率版][内附1-4] |
| tg-peccxinpd | no-direct-resource | 0 | 盘链资源频道 – Telegram |
| tg-q66share | passed | 3 | 鱿鱼游戏 第二季(含S1)✨Netflix超高码 4K HDR DV 5.1Atmos【112G】韩语/多国字幕 |
| tg-quanziyuanshe | passed | 12 | 斗破苍穹 年番 (2022) |
| tg-quark_movies | passed | 17 | 斗破苍穹年番 4K更新至206集 |
| tg-quarkshare | passed | 17 | 斗破苍穹年番 |
| tg-sharealiyun | passed | 14 | 斗破苍穹：年番（2022）4K更至EP83 |
| tg-taoxgzy | passed | 14 | 斗破苍穹 (2017) 4K 臻彩 杜比音效 S05E096-E140 |
| tg-tianyifc | passed | 14 | 韩剧分享三 |
| tg-tianyirigeng | no-direct-resource | 0 | tianyirigeng – Telegram |
| tg-txtyzy | no-direct-resource | 0 | 埃菲尔花园 – Telegram |
| tg-tyypzhpd | no-direct-resource | 0 | 天翼云盘资源频道 – Telegram |
| tg-tyysypzypd | no-direct-resource | 0 | tyysypzypd – Telegram |
| tg-ucquark | passed | 12 | 斗破苍穹 年番 4K 更新至191集 |
| tg-ucwpzy | passed | 15 | 【全13集】少女大战异世界 (2024丨NF 1080P丨内封中字) |
| tg-vip115hot | passed | 2 | [国产剧][斗破苍穹][2018][全42集][国语中字][4K-2160P][35G] |
| tg-wp123zy | passed | 6 | 斗破苍穹 年番 (2025)【4K 臻彩视听】【更新至 146 集】 |
| tg-xiangxiunbb | passed | 16 | 纵横古今我靠神秘古井逆袭人生 (72集) 李昱潼&秦牛正威 ／ 短剧 |
| tg-xx123pan | passed | 6 | 斗破苍穹 |
| tg-yingshifenxiang123 | passed | 18 | 天久鹰央的推理病历表 (2025) |
| tg-ysxb48 | no-direct-resource | 0 | 115网盘 – Telegram |
| tg-yunpan139 | passed | 3 | 斗破苍穹·年番4 4K臻彩10bit 更新至207集 |
| tg-yunpan189 | passed | 9 | 海尔兄弟 高清重制版 (2025) 1080P 212集全 已完结 |
| tg-yunpanuc | passed | 16 | 斗破苍穹 年番 (2023) 4K 臻彩 更新EP139 |
| tg-yunpanxunlei | passed | 13 | 斗破苍穹4：逃亡 (2025) 真人版 |
| tg-yydf_hzl | passed | 17 | 斗破苍穹 更至189 |
| tg-zaihuayun | no-direct-resource | 0 | 🎬 阿里云盘资源 🆙 🚦 – Telegram |
| tg-zyfb123 | passed | 11 | 斗破苍穹 (2017) |

## 复验命令

- pnpm run test:transforms（不依赖当前配置，使用内存 SQLite）
- pnpm run test:transforms:configured（读取当前配置逐一验证）
- pnpm run test:transforms:live（请求全部启用上游；空结果/网络错误会返回非零退出码，不虚报全部通过）
- pnpm exec jiti scripts/test-transforms-replay.ts（需要先取得本地真实响应）
- pnpm run typecheck

新增 / 修复存量配置的脚本：scripts/update-telegram-transforms.ts、scripts/update-hunhepan-transform.ts。
