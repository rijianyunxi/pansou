import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

test('pagination accepts numeric v-model values and rejects out-of-range pages', async () => {
  const source = await readFile(new URL('../components/admin/AdminPagination.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'pagination-test' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = name => name === 'vue' ? { ...vue, useId: () => 'test-page' } : {};
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  const changes = [];
  const props = vue.reactive({ page: 1, totalPages: 100, total: 2000, pageSize: 20 });
  const scope = vue.effectScope();
  try {
    const component = scope.run(() => module.exports.default.setup(props, {
      expose() {}, emit: (event, value) => changes.push([event, value]),
    }));
    // Vue's type="number" v-model automatically produces numbers after editing.
    component.jumpPage.value = 42;
    component.submitJump();
    assert.deepEqual(changes, [['change', 42]]);
    props.page = 42;
    await vue.nextTick();
    assert.equal(component.jumpPage.value, '42');
    component.submitJump();
    assert.equal(changes.length, 1);
    for (const invalid of ['', 0, 101, 1.5, 'invalid']) {
      component.jumpPage.value = invalid;
      component.submitJump();
      assert.match(component.jumpError.value, /1-100/);
      assert.equal(changes.length, 1);
    }
    component.jumpPage.value = ' 7 ';
    component.submitJump();
    assert.deepEqual(changes[1], ['change', 7]);
    assert.equal(component.jumpError.value, '');
    props.disabled = true;
    component.jumpPage.value = 8;
    component.submitJump();
    assert.equal(changes.length, 2, 'disabled pagination must not submit a jump');
  } finally {
    scope.stop();
  }
});
