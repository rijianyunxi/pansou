import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TASK_KINDS, taskFilters, taskLabel, taskReason, taskObservation } from '../lib/backgroundTasks.ts';
import { LINK_LANES, linkLane, laneEnabled, laneView, workerSettings } from '../lib/linkWorkerControls.ts';
test('link task workbench covers link worker lanes without duplicating TG or manual cloud operations',()=>{
  assert.deepEqual(TASK_KINDS.map(c=>c.key),['checks','resolve','cleanup','maintenance']);
  for(const c of TASK_KINDS)assert.ok(c.statuses.includes('all'));
});
test('task filters reject malformed URL state and inapplicable filters',()=>{
  assert.deepEqual(taskFilters({kind:'checks',provider:'aliyun',status:'attention'}),{kind:'checks',provider:'aliyun',status:'attention',page:1,pageSize:20});
  assert.deepEqual(taskFilters({kind:['sync'],status:['all'],provider:'fake',before:['fake']}),{kind:'checks',status:'all',provider:'',page:1,pageSize:20});
  for(const kind of ['crawl','operations'])assert.equal(taskFilters({kind}).kind,'checks');
  assert.equal(taskFilters({kind:'sync'}).kind,'checks');
  assert.equal(taskFilters({kind:'maintenance',provider:'quark'}).provider,'');
  assert.equal(taskFilters({before:'legacy-cursor'}).page,1);
  assert.equal(taskFilters({page:'3',pageSize:'50'}).pageSize,50);
});
test('link workbench uses TG-style table actions and drawers for every category',async()=>{
  const page=await readFile(new URL('../pages/admin/tasks.vue',import.meta.url),'utf8');
  const cleanup=await readFile(new URL('../pages/admin/link-cleanup.vue',import.meta.url),'utf8');
  const table=await readFile(new URL('../components/admin/LinkTaskTable.vue',import.meta.url),'utf8');
  for(const source of [page,cleanup]){
    assert.match(source,/<LinkTaskTable/);assert.match(source,/<thead>/);
    assert.match(source,/scope="col"/);assert.match(source,/<AdminRowActions/);
    assert.match(source,/<AdminDialog v-if="detail" drawer wide :busy=/);
    assert.doesNotMatch(source,/class="(?:task-card|cleanup-task)"/);
  }
  assert.match(table,/overflow-x:auto/);assert.match(table,/role="region".*tabindex="0"/);
  assert.doesNotMatch(page,/CrawlJobDetail|kind==='crawl'|'operations'/);
  const monitor=await readFile(new URL('../components/monitor/MonitorPanel.vue',import.meta.url),'utf8');
  const crawl=await readFile(new URL('../pages/admin/crawl.vue',import.meta.url),'utf8');
  assert.match(monitor,/queue.key==='crawl'\?'\/admin\/crawl'/);
  assert.doesNotMatch(monitor,/\/admin\/tasks\?kind=crawl/);
  assert.doesNotMatch(crawl,/全部采集任务|\/admin\/tasks/);
});
test('observations distinguish job completion, link validity and safe fallback',()=>{
  assert.equal(taskObservation({status:'completed',validity:-1}),'有效性未确认');
  assert.equal(taskObservation({status:'completed',delivery:'original'}),'返回原链接');
  assert.equal(taskObservation({delivery:'reshared',cacheHit:true}),'已复用转存分享');
  assert.match(taskReason('deadline_exceeded'),/超时.*另行清理/);
  assert.match(taskReason('rate_limited'),/不要连续重试/);
  assert.equal(taskLabel('uncertain'),'结果待核实');
});
test('task routes preserve legacy cleanup and never offer generic cloud replay',async()=>{
  const page=await readFile(new URL('../pages/admin/tasks.vue',import.meta.url),'utf8');
  const routes=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(routes,/path: "tasks"/);assert.match(routes,/path: "link-cleanup"/);
  assert.match(page,/\/api\/admin\/tasks\/checks\/\$\{task.id\}\/retry/);
  assert.doesNotMatch(page,/\/tasks\/(resolve|operations).*\/retry/);
  assert.match(page,/active!==controller\|\|active.signal.aborted/);
  assert.match(page,/!detail.value&&!confirm.open.value/);
});
test('link scheduling is controlled inline with graceful pause and failure recovery',async()=>{
  const page=await readFile(new URL('../pages/admin/tasks.vue',import.meta.url),'utf8');
  const controls=await readFile(new URL('../components/admin/LinkWorkerControls.vue',import.meta.url),'utf8');
  assert.match(page,/<LinkWorkerControls/);
  assert.doesNotMatch(page,/运行监控与调度开关/);
  assert.match(controls,/\/api\/admin\/runtime\/workers\/\$\{kind\}/);
  assert.match(controls,/当前批次完成后暂停.*用户按需取链仍可使用/);
  assert.match(controls,/Object.assign\(worker.value, workerSettings\(result.data.settings\)\)/);
  assert.ok(page.indexOf('<LinkWorkerControls') < page.indexOf('<nav class="task-categories"'));
  assert.doesNotMatch(page,/<LinkWorkerControls[^>]*:kind=/);
  assert.match(controls,/role="alert"/);
  assert.match(controls,/worker\?\.scheduleEnabled==null/);
  assert.match(controls,/controller\?\.abort\(\)/);
  assert.match(controls,/!props.suspended&&!confirm.open.value/);
});
test('each scheduled category has an independent endpoint and the interactive lane has none',()=>{
  assert.deepEqual(Object.values(LINK_LANES).map(l=>l.endpoint),['link-check','cleanup','link-maintenance']);
  assert.deepEqual(Object.values(LINK_LANES).map(l=>l.flag),['checkEnabled','enabled','maintenanceEnabled']);
  assert.equal(linkLane('resolve'),null);
  const settings={linkScheduleEnabled:true,linkEnabled:false,linkCheckEnabled:true,linkMaintenanceEnabled:true};
  const flags=workerSettings(settings), worker={state:'online',count:1,...flags};
  assert.equal(laneView('cleanup',worker,true).label,'已暂停');
  assert.equal(laneView('checks',worker,true,1).label,'可调度');
  assert.equal(laneView('maintenance',worker,true).label,'可调度');
});
test('configured state is separate from global scheduling, check policy and worker presence',()=>{
  const worker={state:'online',count:1,enabled:true,scheduleEnabled:true,checkEnabled:true,maintenanceEnabled:true};
  assert.equal(laneView('checks',{...worker,scheduleEnabled:false},true).label,'总调度暂停');
  assert.deepEqual(laneView('checks',worker,false),{state:'paused',label:'检测未启用'});
  assert.equal(laneEnabled('checks',worker,false),false);
  assert.equal(laneEnabled('checks',worker,true),true);
  assert.equal(laneView('checks',worker).label,'状态未知');
  assert.equal(laneView('checks',worker,true,0).label,'无可用账号');
  assert.equal(laneView('checks',worker,true).label,'账号状态未知');
});
test('link task controls keep lane switches while monitor cards offer global scheduling and navigation',async()=>{
  const controls=await readFile(new URL('../components/admin/LinkWorkerControls.vue',import.meta.url),'utf8');
  const cleanup=await readFile(new URL('../pages/admin/link-cleanup.vue',import.meta.url),'utf8');
  const monitor=await readFile(new URL('../components/monitor/MonitorPanel.vue',import.meta.url),'utf8');
  const policy=await readFile(new URL('../components/admin/CloudPolicyDialog.vue',import.meta.url),'utf8');
  const routes=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(controls,/v-for="lane in lanes"/);
  assert.match(controls,/activateChecks:true/);
  assert.match(controls,/当前检测功能已关闭.*按现有账号、频率、额度和熔断策略/);
  assert.doesNotMatch(cleanup,/LinkWorkerControls/);
  assert.match(monitor,/@click="toggle\(service.kind\)"/);
  assert.match(monitor,/:to="MONITOR_WORKERS\[service.kind\].path"/);
  assert.doesNotMatch(monitor,/v-if="service.kind==='crawl'"|暂停清理|恢复清理/);
  assert.doesNotMatch(policy,/checkEnabled|activateChecks/);
  assert.match(policy,/providerError\(props\.provider, form\)/);
  assert.match(routes,/path: "link-cleanup", redirect:.*kind: "cleanup"/);
});
test('task status colors distinguish all states with readable light and dark pairs',async()=>{
  const badge=await readFile(new URL('../components/admin/TaskStatusBadge.vue',import.meta.url),'utf8');
  const shared=await readFile(new URL('../components/admin/AdminStatusBadge.vue',import.meta.url),'utf8');
  const pairs=[...shared.matchAll(/--status-fg:\s*(#[0-9a-f]{6});\s*--status-bg:\s*(#[0-9a-f]{6})/g)];
  function lightness(hex){const values=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);return values[0]*0.2126+values[1]*0.7152+values[2]*0.0722;}
  assert.equal(pairs.length,10);
  for(const [,fg,bg] of pairs){const a=lightness(fg),b=lightness(bg);assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,`${fg} on ${bg}`);}
  for(const state of ['queued','running','completed','failed','blocked','uncertain'])assert.match(shared,new RegExp(`${state}: '([a-z]+)'`));
  assert.match(badge, /state === 'blocked' \? 'warning'/);
  assert.match(shared,/:global\(\.dark \.admin-status-badge/);assert.match(badge,/aria-hidden="true"[\s\S]*label/);
  const {parse,compileStyle}=await import('@vue/compiler-sfc');
  const style=parse(shared).descriptor.styles[0].content;
  const compiled=compileStyle({source:style,filename:'AdminStatusBadge.vue',id:'test',scoped:true});
  assert.deepEqual(compiled.errors,[]);
  assert.match(compiled.code,/\.dark \.admin-status-badge\[data-tone="success"\]/);
  for(const file of ['tasks.vue','link-cleanup.vue'])assert.match(await readFile(new URL('../pages/admin/'+file,import.meta.url),'utf8'),/<TaskStatusBadge :state="task.status"/);
});
