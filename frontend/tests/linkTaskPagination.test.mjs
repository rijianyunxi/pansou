import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import * as backgroundTasks from '../lib/backgroundTasks.ts';
import * as cleanupTasks from '../lib/cleanupTasks.ts';
import { adminPaginationFilters } from '../lib/adminPagination.ts';

test('pagination URL state accepts supported sizes and normalizes malformed values', () => {
  assert.deepEqual(adminPaginationFilters({ page: '3', pageSize: '50' }), { page: 3, pageSize: 50 });
  assert.deepEqual(adminPaginationFilters({ page: '999999', pageSize: '10' }), { page: 100000, pageSize: 10 });
  for (const value of ['', '0', '-1', '2.5', 'Infinity', 'bad', ['20']]) {
    assert.deepEqual(adminPaginationFilters({ page: value, pageSize: value }), { page: 1, pageSize: 20 });
  }
});

async function workbench(file, kind) {
  const source = await readFile(new URL(`../pages/admin/${file}`, import.meta.url), 'utf8');
  const script = compileScript(parse(source).descriptor, { id: 'task-pagination-test' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const route = vue.reactive({ query: { kind, status: 'all', provider: 'quark', page: '2', pageSize: '10' } });
  const navigate = ({ query }) => { route.query = query; return Promise.resolve(); };
  const requests = [];
  let total = 65;
  const apiFetch = async path => {
    const url = new URL(path, 'http://fixture.local');
    requests.push(url);
    const page = Number(url.searchParams.get('page'));
    const pageSize = Number(url.searchParams.get('pageSize'));
    const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize)) }, (_, i) => ({ id: (page - 1) * pageSize + i }));
    return { data: { items, total, enabled: true } };
  };
  const require = name => {
    if (name === 'vue') return { ...vue, onMounted() {}, onBeforeUnmount() {} };
    if (name === 'vue-router') return { useRoute: () => route, useRouter: () => ({ push: navigate, replace: navigate }) };
    if (name.endsWith('/appRuntime')) return { apiFetch, apiErrorMessage: String, setDocumentHead() {} };
    if (name.endsWith('/backgroundTasks')) return backgroundTasks;
    if (name.endsWith('/cleanupTasks')) return cleanupTasks;
    if (name.endsWith('/useAdminConfirm')) return { useAdminConfirm: () => ({ open: vue.ref(false) }) };
    return {};
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  const scope = vue.effectScope();
  const component = scope.run(() => module.exports.default.setup({ embedded: true }, { expose() {}, emit() {} }));
  const settle = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); };
  return { component, route, requests, settle, stop: () => scope.stop(), setTotal: value => { total = value; } };
}

for (const [file, kind] of [['tasks.vue', 'checks'], ['link-cleanup.vue', 'cleanup']]) {
  test(`${kind} pagination fetches the selected page, resets on size/filter changes, and repairs empty tail pages`, async () => {
    const view = await workbench(file, kind);
    const { component, route, requests, settle } = view;
    try {
      await component.load();
      assert.equal(requests.at(-1).searchParams.get('page'), '2');
      assert.equal(requests.at(-1).searchParams.get('pageSize'), '10');
      assert.equal(component.tasks.value.length, 10);
      assert.equal(component.totalPages.value, 7);
      component.changePage(4);
      await settle();
      assert.equal(requests.at(-1).searchParams.get('page'), '4');
      assert.equal(component.tasks.value[0].id, 30);
      component.changePageSize(50);
      await settle();
      assert.equal(component.filters.value.page, 1);
      assert.equal(requests.at(-1).searchParams.get('pageSize'), '50');
      assert.equal(component.tasks.value.length, 50);
      assert.equal(component.totalPages.value, 2);
      component.changePage(2);
      await settle();
      assert.equal(component.tasks.value.length, 15);
      view.setTotal(5);
      await component.load();
      await settle();
      assert.equal(component.filters.value.page, 1);
      assert.equal(component.tasks.value.length, 5);
      view.setTotal(0);
      await component.load();
      assert.equal(component.totalPages.value, 1);
      assert.equal(component.tasks.value.length, 0);
      route.query = { ...route.query, page: '2' };
      await settle();
      const setFilter = component.setFilter || component.filter;
      setFilter('provider', 'aliyun');
      await settle();
      assert.equal(component.filters.value.page, 1);
      assert.equal(component.filters.value.pageSize, 50);
      assert.equal(requests.at(-1).searchParams.get('provider'), 'aliyun');
    } finally {
      view.stop();
    }
  });
}
