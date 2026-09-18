#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const defaults = { url: 'https://pan.letus.lol', duration: 600, rate: 100, timeout: 120, concurrency: 500 };
const help = `POST /api/search 匿名用户压测（Node.js 20+，无需安装依赖）
node scripts/load-search.mjs [选项]
  --url URL                默认 https://pan.letus.lol
  --duration-seconds N      默认 600（10 分钟的发起窗口，然后等待在途请求结束）
  --users-per-minute N      默认 100（每个用户一个独立会话、一次搜索）
  --timeout-seconds N       默认 120（会话与搜索合计超时）
  --max-concurrency N       默认 500，达到后记为 skipped，不排队补发
  --keywords FILE          UTF-8 文本，每行一个关键词，忽略空行，去重后须足量
  --output DIR             报告目录，必须为尚不存在的新目录
  --dry-run                生成计划和关键词，不发送任何请求
  --help                   显示帮助
Ctrl+C 停止发起、取消在途请求并生成已有数据报告。无自动重试。`;

export function builtInKeywords() {
  const titles = `三体 流浪地球 沙丘 星际穿越 盗梦空间 肖申克的救赎 阿甘正传 泰坦尼克号 阿凡达 奥本海默 信条 记忆碎片 致命魔术 蝙蝠侠黑暗骑士 这个杀手不太冷 楚门的世界 海上钢琴师 美丽人生 天堂电影院 放牛班的春天 千与千寻 龙猫 哈尔的移动城堡 天空之城 风之谷 幽灵公主 你的名字 天气之子 铃芽之旅 灌篮高手 寻梦环游记 心灵奇旅 机器人总动员 飞屋环游记 头脑特工队 疯狂动物城 超能陆战队 功夫 熊猫功夫 西游记 红楼梦 水浒传 三国演义 琅琊榜 甄嬛传 庆余年 漫长的季节 隐秘的角落 沉默的真相 狂飙 繁花 大明王朝1566 走向共和 雍正王朝 康熙王朝 武林外传 父母爱情 山海情 人世间 大江大河 开端 梦华录 去有风的地方 莲花楼 唐朝诡事录 白夜追凶 无证之罪 都挺好 欢乐颂 仙剑奇侠传 亮剑 士兵突击 我的团长我的团 潜伏 悬崖 风筝 北平无战事 觉醒年代 长安十二时辰 陈情令 请回答1988 机智的医生生活 信号 秘密森林 黑暗荣耀 孤独的美食家 非自然死亡 半泽直树 重启人生 老友记 生活大爆炸 权力的游戏 绝命毒师 风骚律师 越狱 神探夏洛克 怪奇物语 黑镜 西部世界 曼达洛人 最后生还者 切尔诺贝利 纸牌屋 唐顿庄园 王冠 摩登家庭 破产姐妹 行尸走肉 傲慢与偏见 指环王 哈利波特 加勒比海盗 碟中谍 谍影重重 黑客帝国 速度与激情 复仇者联盟 银河护卫队 钢铁侠 美国队长 蜘蛛侠 蝙蝠侠 超人 侏罗纪公园 侏罗纪世界 终结者 异形 普罗米修斯 银翼杀手 源代码 明日边缘 火星救援 地心引力 独立日 后天 釜山行 寄生虫 素媛 辩护人 熔炉 七号房的礼物 我不是药神 让子弹飞 活着 霸王别姬 无间道 英雄 卧虎藏龙 一代宗师 东邪西毒 重庆森林 花样年华 甜蜜蜜 喜剧之王 大话西游 九品芝麻官 唐伯虎点秋香 食神 少林足球 功夫熊猫 哪吒之魔童降世 白蛇缘起 长安三万里 雄狮少年 深海 大护法 罗小黑战记 中国奇谭 舌尖上的中国 河西走廊 如果国宝会说话 我在故宫修文物 地球脉动 蓝色星球 宇宙时空之旅 人生一串 风味人间 水果传`.split(/\s+/);
  const media = titles.flatMap(title => ['', '全集', '高清', '1080P', '4K', '中文字幕'].map(s => `${title} ${s}`.trim()));
  const topics = 'Python Java JavaScript TypeScript Go Rust C语言 C++ 算法 数据结构 计算机网络 操作系统 Linux Docker Kubernetes MySQL Redis PostgreSQL Vue React 前端开发 后端开发 软件测试 人工智能 机器学习 深度学习 大模型 数据分析 数学 线性代数 概率论 高等数学 英语 日语 韩语 法语 德语 摄影 剪辑 Photoshop Blender 绘画 吉他 钢琴 围棋 国际象棋 考研 公务员考试 雅思 托福'.split(' ');
  return [...new Set([...media, ...topics.flatMap(t => ['入门教程', '视频课程', '实战教程', '电子书'].map(s => `${t} ${s}`))])];
}

function options(argv) {
  const o = { ...defaults };
  const keys = { '--url': 'url', '--duration-seconds': 'duration', '--users-per-minute': 'rate', '--timeout-seconds': 'timeout', '--max-concurrency': 'concurrency', '--keywords': 'keywords', '--output': 'output' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { console.log(help); return null; }
    if (arg === '--dry-run') { o.dryRun = true; continue; }
    const key = keys[arg];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`无效参数：${arg}`);
    o[key] = ['duration', 'rate', 'timeout', 'concurrency'].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  for (const key of ['duration', 'rate', 'timeout', 'concurrency']) if (!Number.isFinite(o[key]) || o[key] <= 0) throw new Error(`${key} 必须为正数`);
  if (!Number.isSafeInteger(o.concurrency)) throw new Error('max-concurrency 必须是整数');
  const url = new URL(o.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('url 必须是 http(s) 域名根地址');
  o.url = url.origin;
  o.count = Math.floor(o.duration * o.rate / 60);
  if (o.count < 1) throw new Error('计划用户数不足 1');
  return o;
}

export function stats(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!a.length) return { n: 0, avg: null, p50: null, p95: null, p99: null, max: null };
  const percentile = p => a[Math.max(0, Math.ceil(a.length * p) - 1)];
  return { n: a.length, avg: a.reduce((a, b) => a + b, 0) / a.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: a.at(-1) };
}

// Incremental line parsing tolerates UTF-8 and CRLF split at arbitrary network boundaries.
export async function consumeSse(response, onEvent, onBytes) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = 'message', data = [];
  function line(raw) {
    const s = raw.replace(/\r$/, '');
    if (!s) {
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
      event = 'message'; data = []; return;
    }
    if (s.startsWith(':')) return;
    const pos = s.indexOf(':');
    const key = pos < 0 ? s : s.slice(0, pos);
    const val = pos < 0 ? '' : s.slice(pos + 1).replace(/^ /, '');
    if (key === 'event') event = val;
    if (key === 'data') data.push(val);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) onBytes(value.length);
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 16 * 1024 * 1024) throw new Error('单条 SSE 行超过 16 MiB');
      if (done) break;
    }
    // A real SSE event must end with a blank line; unflushed trailing data is incomplete.
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function simulate(o, keyword, id, scheduledMs, started, controllers) {
  const begin = performance.now();
  const row = { id, keyword, scheduledMs, minute: Math.floor(scheduledMs / 60000) + 1, startedAt: new Date().toISOString(), actualStartMs: begin - started, lagMs: Math.max(0, begin - started - scheduledMs), outcome: 'failed', stage: 'session', sessionStatus: null, searchStatus: null, sessionMs: null, headersMs: null, firstEventMs: null, firstResultMs: null, searchMs: null, bytes: 0, resultEvents: 0, resultItems: 0, total: null };
  const controller = new AbortController(); controllers.add(controller);
  let timedOut = false, searchBegin;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, o.timeout * 1000);
  const baseHeaders = { Origin: o.url, Referer: `${o.url}/`, 'User-Agent': 'PanHub-Search-LoadTest/1.0' };
  try {
    const session = await fetch(`${o.url}/api/account/session`, { headers: baseHeaders, signal: controller.signal, redirect: 'error' });
    row.sessionStatus = session.status;
    if (!session.ok) { await session.body?.cancel(); throw new Error(`Session HTTP ${session.status}`); }
    const cookie = session.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const identity = await session.json();
    row.sessionMs = performance.now() - begin;
    if (!cookie || !identity.sessionId) throw new Error('会话响应缺少 Cookie 或 sessionId');
    row.sessionId = identity.sessionId;
    row.stage = 'search'; searchBegin = performance.now();
    const response = await fetch(`${o.url}/api/search`, { method: 'POST', headers: { ...baseHeaders, Cookie: cookie, Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ kw: keyword }), signal: controller.signal, redirect: 'error' });
    row.searchStatus = response.status; row.headersMs = performance.now() - searchBegin;
    row.retryAfter = response.headers.get('retry-after');
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Search HTTP ${response.status}`); }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw new Error('搜索未返回 SSE'); }
    let completed = false;
    await consumeSse(response, (event, payload) => {
      row.firstEventMs ??= performance.now() - searchBegin;
      if (event === 'error') throw new Error(`SSE error: ${payload.message || 'unknown'}`);
      if (event === 'result') {
        row.resultEvents++;
        const results = payload.data?.update?.results ?? [];
        row.resultItems += results.length;
        if (results.length) row.firstResultMs ??= performance.now() - searchBegin;
      }
      if (event === 'complete') {
        if (payload.code !== 0) throw new Error(`SSE complete code=${payload.code}: ${payload.message || ''}`);
        if (!Number.isFinite(payload.data?.total)) throw new Error('SSE complete 缺少 total');
        row.total = payload.data.total; completed = true;
      }
    }, bytes => { row.bytes += bytes; });
    if (!completed) throw new Error('SSE 提前结束，未收到 complete');
    row.outcome = 'success';
  } catch (error) {
    row.outcome = timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'failed';
    row.error = timedOut ? `超过 ${o.timeout} 秒` : String(error.message || error);
  } finally {
    clearTimeout(timeout); controllers.delete(controller);
    row.elapsedMs = performance.now() - begin;
    if (searchBegin !== undefined) row.searchMs = performance.now() - searchBegin;
    if (row.sessionMs === null) row.sessionMs = row.elapsedMs;
    row.finishedAt = new Date().toISOString();
  }
  return row;
}

function aggregate(rows) {
  const success = rows.filter(r => r.outcome === 'success');
  const attempted = rows.filter(r => r.outcome !== 'skipped');
  const count = value => rows.filter(r => r.outcome === value).length;
  return { users: attempted.length, searches: rows.filter(r => r.searchMs != null).length, success: success.length, failed: count('failed'), timeout: count('timeout'), cancelled: count('cancelled'), skipped: count('skipped'), successRate: attempted.length ? success.length / attempted.length : null, empty: success.filter(r => r.total === 0).length, bytes: rows.reduce((a, r) => a + (r.bytes || 0), 0), sessionMs: stats(attempted.map(r => r.sessionMs)), headersMs: stats(rows.map(r => r.headersMs)), firstResultMs: stats(rows.map(r => r.firstResultMs)), successSearchMs: stats(success.map(r => r.searchMs)), allSearchMs: stats(rows.map(r => r.searchMs)), endToEndMs: stats(attempted.map(r => r.elapsedMs)), launchLagMs: stats(attempted.map(r => r.lagMs)) };
}
const ms = x => x == null ? '—' : `${Math.round(x)}`;
const pct = x => x == null ? '—' : `${(x * 100).toFixed(2)}%`;
function report(o, rows, meta) {
  const summary = aggregate(rows);
  const minutes = Array.from({ length: Math.ceil(o.duration / 60) }, (_, i) => ({ minute: i + 1, ...aggregate(rows.filter(r => r.minute === i + 1)) }));
  const errors = {}, statuses = {};
  for (const r of rows) {
    if (r.error) { const key = `${r.stage || 'scheduler'}: ${r.error}`; errors[key] = (errors[key] || 0) + 1; }
    for (const stage of ['session', 'search']) if (r[`${stage}Status`] != null) { const key = `${stage} HTTP ${r[`${stage}Status`]}`; statuses[key] = (statuses[key] || 0) + 1; }
  }
  const data = { config: o, ...meta, unlaunched: o.count - rows.length, summary, minutes, statuses, errors };
  writeFileSync(join(o.output, 'summary.json'), JSON.stringify(data, null, 2));
  const metric = (label, value) => `| ${label} | ${value.n} | ${ms(value.avg)} | ${ms(value.p50)} | ${ms(value.p95)} | ${ms(value.p99)} | ${ms(value.max)} |`;
  const text = `# 搜索压测报告\n\n目标：${o.url} — POST /api/search\n\n开始：${meta.startedAt}；结束：${meta.finishedAt}（UTC ISO 时间）。\n\n计划：${o.duration} 秒内 ${o.count} 个用户，${o.rate} 人/分钟；每人独立匿名会话、一次不重复查询。实际运行 ${meta.elapsedSeconds.toFixed(1)} 秒（含在途请求收尾）。${meta.interrupted ? '本次提前停止。' : ''}\n\n- 已启动用户：${summary.users}；发起搜索：${summary.searches}；未调度：${data.unlaunched}；并发上限跳过：${summary.skipped}\n- 完整成功：${summary.success}；失败：${summary.failed}；超时：${summary.timeout}；取消：${summary.cancelled}\n- 用户流程成功率：${pct(summary.successRate)}（成功 / 已启动用户，包含会话初始化失败）\n- 成功但零结果：${summary.empty}；收到非空结果的请求：${summary.firstResultMs.n}\n- 活跃用户峰值：${meta.peakActive}（包含会话初始化和搜索阶段）\n- SSE 接收量：${(summary.bytes / 1024 / 1024).toFixed(2)} MiB（解压后的响应体，不含 HTTP/TLS 开销）\n- 关键词来源：${o.keywords || '内置影视/课程词条及修饰词组合'}；关键词完整清单见 keywords.txt\n\n## 耗时（毫秒）\n\n| 指标 | 样本数 | 平均 | P50 | P95 | P99 | 最大 |\n|---|---:|---:|---:|---:|---:|---:|\n${[metric('会话初始化（含失败）', summary.sessionMs), metric('搜索响应头', summary.headersMs), metric('首个非空结果（有结果请求）', summary.firstResultMs), metric('成功搜索完整 SSE', summary.successSearchMs), metric('全部搜索尝试（含失败/超时）', summary.allSearchMs), metric('用户全流程（含失败/超时）', summary.endToEndMs), metric('用户启动延迟', summary.launchLagMs)].join('\n')}\n\n## 每分钟（按计划启动分钟归组，包含其最终结果）\n\n| 分钟 | 用户 | 搜索 | 成功 | 失败 | 超时 | 取消 | 跳过 | 成功率 | 成功搜索 P95 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${minutes.map(m => `| ${m.minute} | ${m.users} | ${m.searches} | ${m.success} | ${m.failed} | ${m.timeout} | ${m.cancelled} | ${m.skipped} | ${pct(m.successRate)} | ${ms(m.successSearchMs.p95)} |`).join('\n')}\n\n## HTTP 状态与错误\n\n\`\`\`json\n${JSON.stringify({ statuses, errors }, null, 2)}\n\`\`\`\n\n## 如何解读\n\n完整成功要求 HTTP 正常、收到 code=0 的 complete 事件并正常结束流；HTTP 200 本身不代表成功。成功耗时不含失败样本，需同时查看全部尝试耗时和错误率。首结果指标排除零结果请求，并不代表全部用户体验。\n\n本次使用单客户端、单出口 IP，按固定间隔启动匿名用户，无重试，不加载网页静态资源，也不模拟登录及多次搜索。每分钟 100 人表示到达速率，并非同时保持 100 并发。会话初始化另增加约 100 次请求/分钟。\n\n内置查询是合成负载，不等同于真实热词分布；修饰词可能产生零结果。每个查询字符串仅出现一次，但不会清除服务器已有缓存。更真实的测试可通过 --keywords 提供实际搜索词。SSE 接口没有全部来源的诊断数据，成功不保证每个上游来源都成功。\n\n本报告不采集服务器 CPU、内存、磁盘或网络指标。请按开始/结束时间与服务端监控对照；启动延迟较大或出现 skipped 说明客户端未达到计划负载。requests.jsonl 包含各请求时间、会话 ID、关键词和结果指标，不保存 Cookie 或搜索结果内容。\n`;
  writeFileSync(join(o.output, 'report.md'), text);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const o = options(argv); if (!o) return;
  let keywords = o.keywords ? readFileSync(o.keywords, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/) : builtInKeywords();
  keywords = [...new Set(keywords.map(x => x.trim().normalize('NFC')).filter(Boolean))];
  if (keywords.length < o.count) throw new Error(`需要 ${o.count} 个不重复关键词，当前只有 ${keywords.length} 个，请用 --keywords 提供更多`);
  if (keywords.some(k => k.length > 100)) throw new Error('关键词不得超过 100 字符');
  for (let i = keywords.length - 1; i > 0; i--) { const j = randomInt(i + 1); [keywords[i], keywords[j]] = [keywords[j], keywords[i]]; }
  keywords = keywords.slice(0, o.count);
  o.output = resolve(o.output || `load-reports/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(resolve(o.output, '..'), { recursive: true }); mkdirSync(o.output);
  writeFileSync(join(o.output, 'keywords.txt'), keywords.join('\n') + '\n');
  writeFileSync(join(o.output, 'plan.json'), JSON.stringify(o, null, 2));
  console.log(`目标 ${o.url} | ${o.count} 人 / ${o.duration} 秒 | ${o.rate} 人/分钟 | 输出 ${o.output}`);
  if (o.dryRun) { console.log('Dry run：仅生成计划，未发送网络请求。'); return; }
  const log = join(o.output, 'requests.jsonl'); writeFileSync(log, '');
  const rows = [], pending = new Set(), controllers = new Set();
  const startedAt = new Date().toISOString(), started = performance.now();
  let stopped = false, peakActive = 0, fatal;
  const schedule = new AbortController();
  const stop = () => { stopped = true; schedule.abort(); for (const c of controllers) c.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const save = row => { rows.push(row); appendFileSync(log, JSON.stringify(row) + '\n'); };
  const ticker = setInterval(() => {
    const a = aggregate(rows);
    console.log(`[${Math.round((performance.now() - started) / 1000)}s] 已结束 ${rows.length}/${o.count}，活跃 ${pending.size}，成功 ${a.success}，失败 ${a.failed}，超时 ${a.timeout}，跳过 ${a.skipped}`);
  }, 10000);
  try {
    for (let i = 0; i < o.count && !stopped; i++) {
      const scheduledMs = i * 60000 / o.rate;
      const wait = scheduledMs - (performance.now() - started);
      if (wait > 0) await sleep(wait, undefined, { signal: schedule.signal });
      if (stopped) break;
      if (pending.size >= o.concurrency) {
        save({ id: i + 1, keyword: keywords[i], scheduledMs, minute: Math.floor(scheduledMs / 60000) + 1, outcome: 'skipped', error: '达到客户端并发上限', startedAt: new Date().toISOString() }); continue;
      }
      const p = simulate(o, keywords[i], i + 1, scheduledMs, started, controllers).then(save).catch(error => { fatal = error; stop(); }).finally(() => pending.delete(p));
      pending.add(p); peakActive = Math.max(peakActive, pending.size);
    }
    const remaining = o.duration * 1000 - (performance.now() - started);
    if (!stopped && remaining > 0) await sleep(remaining, undefined, { signal: schedule.signal });
  } catch (error) { if (!stopped) { fatal = error; stop(); } }
  finally {
    await Promise.allSettled([...pending]); clearInterval(ticker);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    const summary = report(o, rows, { startedAt, finishedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000, peakActive, interrupted: stopped });
    console.log(`报告：${join(o.output, 'report.md')}\n成功 ${summary.success}/${summary.users}，成功率 ${pct(summary.successRate)}`);
    if (fatal) throw fatal;
    if (stopped) process.exitCode = 130;
    else if (summary.failed || summary.timeout || summary.skipped) process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
