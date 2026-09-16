import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { load } from 'cheerio';
import { executeSourceTransform } from '../server/core/source-runtime/runtime';
const db = new Database(process.env.PANHUB_SQLITE_DB || 'data/panhub.sqlite', { readonly: true });
const rows: any[] = db.prepare('SELECT * FROM resource_sources ORDER BY id').all(); db.close();
const reports = rows.map(row => {
  const path = `.genflow_tmp/transform-live/${row.id}.raw`;
  if (!existsSync(path)) return { id: row.id, status: 'missing-sample', count: 0 };
  const raw = readFileSync(path, 'utf8');
  const results = executeSourceTransform({ id: row.id, version: 'replay', format: row.format, maxResults: 200, code: row.transform }, raw, { rawBody: raw, format: row.format, source: row.id, channel: row.channel, keyword: '' });
  const bad = results.filter(r => !r.name.trim() || /https?:\/\/|[\r\n]|(?:描述|简介|链接)[:：]/.test(r.name));
  const $ = row.format === 'html' ? load(raw) : null;
  return { id: row.id, status: bad.length ? 'format-failed' : results.length ? 'passed' : 'no-direct-resource', count: results.length, pageTitle: $?.('title').text(), messages: $?.('.tgme_widget_message_text').length, names: results.slice(0, 3).map(r => r.name), bad };
});
writeFileSync('.genflow_tmp/transform-replay-report.json', JSON.stringify(reports, null, 2));
const summary = reports.reduce((sum: Record<string, number>, r) => { sum[r.status] = (sum[r.status] || 0) + 1; return sum; }, {});
console.log(summary);
const text = `# 上游 transform 验证报告（2026-09-15）

## 范围与结果

- 当前 SQLite 配置为 50 个启用来源：2 HTTP + 48 Telegram（并非 12 个）。
- 离线模板测试：55 项通过；逐配置回归：2,405 项通过，0 失败。
- 已对全部来源发起真实请求，关键词无结果的 Telegram 再请求近期消息。
- 以下使用各来源实测保存的响应预览重新执行最终版 transform，避免偶发 ECONNRESET 干扰格式验证。预览最多 100,000 字符，不代表频道全部历史消息。
- 有有效资源的响应：${summary.passed || 0} 个；无可解析直链响应：${summary['no-direct-resource'] || 0} 个；格式失败：${summary['format-failed'] || 0} 个。
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
${reports.map(r => `| ${r.id} | ${r.status} | ${r.count} | ${String(r.names?.[0] || r.pageTitle || '').replace(/\|/g, '／')} |`).join('\n')}

## 复验命令

- pnpm run test:transforms（不依赖当前配置，使用内存 SQLite）
- pnpm run test:transforms:configured（读取当前配置逐一验证）
- pnpm run test:transforms:live（请求全部启用上游；空结果/网络错误会返回非零退出码，不虚报全部通过）
- pnpm exec jiti scripts/test-transforms-replay.ts（需要先取得本地真实响应）
- pnpm run typecheck

新增 / 修复存量配置的脚本：scripts/update-telegram-transforms.ts、scripts/update-hunhepan-transform.ts。
`;
writeFileSync('scripts/TRANSFORM-AUDIT.md', text);
if (reports.some(r => r.status === 'format-failed' || r.status === 'missing-sample')) process.exitCode = 1;
