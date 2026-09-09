/** Bounded, opt-in live diagnostics. Run: node test/upstream-diagnostics.mjs [keyword]
 * Invokes the registered plugins directly, bypassing search cache and keyword variants.
 * Does not change the running application or send authentication credentials.
 */
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const nuxtRequire = createRequire(require.resolve('nuxt/package.json'));
const { createJiti } = nuxtRequire('jiti');
const jiti = createJiti(import.meta.url);
const context = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch.bind(globalThis);
const keyword = process.argv[2] || '三体';
const report = {
  startedAt: new Date().toISOString(), keyword,
  limits: { pluginBudgetMs: 20000, requestBudgetMs: 10000, maxRequestsPerPlugin: 12, maxBodyBytes: 2 * 1024 * 1024 },
  mode: 'Direct registered plugin invocation; no service cache or keyword variants; original plugin retry logic retained, subject to diagnostic limits.',
  plugins: [], requests: [],
};

function errorInfo(error) {
  return { name: error?.name, message: error?.message, code: error?.code, cause: error?.cause ? errorInfo(error.cause) : undefined };
}

globalThis.fetch = async (input, init = {}) => {
  const scope = context.getStore();
  if (!scope) return nativeFetch(input, init);
  if (scope.controller.signal.aborted || scope.count >= report.limits.maxRequestsPerPlugin) {
    scope.suppressed++;
    throw new Error('Diagnostic request/budget limit reached');
  }
  scope.count++;
  const row = { plugin: scope.name, url: typeof input === 'string' ? input : input.url || String(input), method: init.method || input.method || 'GET', startedAt: new Date().toISOString() };
  report.requests.push(row);
  const start = performance.now();
  const signals = [scope.controller.signal, AbortSignal.timeout(report.limits.requestBudgetMs), init.signal || input.signal].filter(Boolean);
  try {
    const response = await nativeFetch(input, { ...init, signal: AbortSignal.any(signals) });
    row.headersMs = Math.round(performance.now() - start);
    row.status = response.status;
    row.finalUrl = response.url;
    row.contentType = response.headers.get('content-type');
    row.server = response.headers.get('server');
    row.retryAfter = response.headers.get('retry-after');
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > report.limits.maxBodyBytes) {
          await reader.cancel();
          throw new Error('Diagnostic response body size limit reached');
        }
        chunks.push(Buffer.from(value));
      }
    }
    const body = Buffer.concat(chunks);
    row.bytes = bytes;
    const text = body.toString('utf8');
    try {
      const json = JSON.parse(text);
      row.jsonSummary = { code: json?.code, status: json?.status, msg: json?.msg, message: typeof json?.message === 'string' ? json.message.slice(0, 250) : undefined, keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 15) : [] };
    } catch {
      row.title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 200);
      row.challengeMarkers = [...new Set(text.match(/captcha|cf-chl-|Just a moment|Access Denied|verify you are human|人机验证|安全验证/gi) || [])];
      if (response.status >= 400) row.errorSnippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 350);
    }
    const rebuilt = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(rebuilt, 'url', { value: response.url });
    return rebuilt;
  } catch (error) {
    row.error = errorInfo(error);
    throw error;
  } finally {
    row.totalMs = Math.round(performance.now() - start);
    console.log(JSON.stringify({ type: 'request', ...row }));
  }
};

await mkdir(path.join(root, 'logs'), { recursive: true });
const output = path.join(root, 'logs', `upstream-diagnostics-${report.startedAt.replace(/[:.]/g, '-')}.json`);
try {
  const { getOrCreateSearchService } = await jiti.import(path.join(root, 'server/core/services/index.ts'));
  const service = getOrCreateSearchService({ cacheEnabled: false, defaultChannels: [], defaultConcurrency: 1, pluginTimeoutMs: 10000 });
  const tasks = service.getPluginManager().getPlugins().map(plugin => ({ name: plugin.name(), run: () => plugin.search(keyword, { __plugin_timeout_ms: 10000 }) }));
  const { fetchTgChannelPosts } = await jiti.import(path.join(root, 'server/core/services/tg.ts'));
  tasks.push({ name: 'tg:tgsearchers3', run: () => fetchTgChannelPosts('tgsearchers3', keyword, { limitPerChannel: 20 }) });
  for (const task of tasks) {
    const scope = { name: task.name, count: 0, suppressed: 0, controller: new AbortController() };
    const timer = setTimeout(() => scope.controller.abort(new Error('Diagnostic plugin 20s budget exceeded')), report.limits.pluginBudgetMs);
    const start = performance.now();
    const summary = { plugin: task.name };
    console.log(`START ${task.name}`);
    try {
      const results = await context.run(scope, task.run);
      summary.resultCount = results.length;
      summary.linkCount = results.reduce((n, r) => n + (r.links?.length || 0), 0);
      summary.sampleTitles = results.slice(0, 3).map(r => r.title);
    } catch (error) { summary.error = errorInfo(error); }
    finally {
      clearTimeout(timer);
      summary.totalMs = Math.round(performance.now() - start);
      summary.requestCount = scope.count;
      summary.suppressedRequests = scope.suppressed;
      summary.budgetExceeded = scope.controller.signal.aborted;
      report.plugins.push(summary);
      await writeFile(output, JSON.stringify(report, null, 2));
      console.log(`SUMMARY ${JSON.stringify(summary)}`);
    }
  }
} finally {
  globalThis.fetch = nativeFetch;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`REPORT ${output}`);
}
