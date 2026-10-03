import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DELIVERY_PROVIDERS, providerRecord, providerForm, providerError, folderKey, providerRoot, selectableDirectory } from '../lib/linkPolicy.ts';
import { adminNavigation } from '../components/admin/navigation.ts';
import { cleanupFilters, cleanupLabel, cleanupError, retryUnavailable } from '../lib/cleanupTasks.ts';

test('cleanup filters restore safe URL state and reject malformed query values', () => {
  assert.deepEqual(cleanupFilters({status:'blocked',provider:'aliyun',page:'3'}),{status:'blocked',provider:'aliyun',page:3,pageSize:20});
  for(const page of ['0','-1','2.5','Infinity',['2']]) assert.equal(cleanupFilters({status:['all'],provider:'fake',page}).page,1);
  assert.deepEqual(cleanupFilters({status:'fake',provider:['aliyun'],page:'999999'}),{status:'all',provider:'',page:100000,pageSize:20});
});
test('cleanup explanations distinguish retry exhaustion, active work and retention', () => {
  assert.match(cleanupError('cleanup_credentials_or_permissions','blocked'),/登录凭据.*自动重试已停止/);
  assert.match(cleanupError('cleanup_busy','queued'),/10 秒/);
  assert.match(cleanupError('unrecognized','failed'),/运行诊断/);
  assert.match(retryUnavailable('not_due'),/不能提前清理/);
  assert.match(retryUnavailable('running'),/不能重复入队/);
  assert.equal(cleanupLabel('transfer_intent'),'转存结果待确认');
});

test('all five delivery providers have independent forms and safe ID directories', () => {
  assert.deepEqual(DELIVERY_PROVIDERS.map(p => p.key), ['quark','baidu','aliyun','xunlei','guangya']);
  const forms = providerRecord(providerForm); forms.aliyun.enabled = true;
  assert.equal(forms.xunlei.enabled, false);
  for (const key of ['aliyun','xunlei','guangya']) {
    assert.equal(folderKey(key,{id:'dedicated',path:'/not-an-id'}), 'dedicated');
    assert.equal(providerError(key,{...providerForm(),enabled:true,hours:24,targetDir:'dedicated'}), '');
    for(const targetDir of ['root','0','/']) assert.match(providerError(key,{...providerForm(),enabled:true,hours:24,targetDir}),/专用目录/);
  }
  assert.equal(providerRoot('aliyun'),'root'); assert.equal(providerRoot('xunlei'),'0'); assert.equal(selectableDirectory(' root '),false);
});
test('cleanup attention has a management menu and a direct task route', async () => {
  assert.ok(adminNavigation.some(p => p.path === '/admin/tasks' && p.title === '链接任务'));
  const monitor = await readFile(new URL('../components/monitor/MonitorPanel.vue',import.meta.url),'utf8');
  assert.match(monitor,/path: '\/admin\/tasks\?kind=cleanup&status=attention', action: '管理清理任务'/);
  const route = await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(route,/path: "link-cleanup"/);
});
