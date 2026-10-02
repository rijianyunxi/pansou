import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

async function setupHotSearch(apiFetch) {
  const source = await readFile(new URL('../components/HotSearchSection.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'hot-search-test' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = name => name === 'vue' ? vue : { apiFetch, appConfig: { apiBase: '/api' } };
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  return module.exports.default.setup({ onSearch() {} }, { expose() {} });
}

const response = hotSearches => ({ code: 0, data: { hotSearches } });

test('hot searches keep the API pinned and tie-breaking order', async () => {
  const items = [
    { term: '置顶', score: 1, pinned: true },
    { term: '更热', score: 100, pinned: false },
    { term: '同热度新搜索', score: 50, pinned: false },
    { term: '同热度旧搜索', score: 50, pinned: false },
  ];
  const component = await setupHotSearch(async () => response(items));
  await component.init();
  assert.deepEqual(component.searches.value, items);
});

test('a failed request or invalid response can be retried', async () => {
  for (const firstAttempt of [() => { throw new Error('offline'); }, () => ({ code: 1 })]) {
    let calls = 0;
    const component = await setupHotSearch(async () => {
      calls++;
      return calls === 1 ? firstAttempt() : response([{ term: '恢复', score: 1, pinned: false }]);
    });
    await component.init();
    assert.equal(component.loading.value, false);
    assert.equal(component.hasInitialized.value, false);
    await component.init();
    assert.equal(calls, 2);
    assert.equal(component.searches.value[0].term, '恢复');
    await component.init();
    assert.equal(calls, 2);
  }
});

test('simultaneous initialization shares one request', async () => {
  let calls = 0;
  let finish;
  const component = await setupHotSearch(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = component.init();
  const second = component.init();
  assert.equal(calls, 1);
  assert.equal(component.loading.value, true);
  finish(response([]));
  await Promise.all([first, second]);
  assert.equal(component.loading.value, false);
  await component.init();
  assert.equal(calls, 1);
});
