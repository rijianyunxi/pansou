import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runCloudMutation, operationWait } from '../lib/cloudDriveOperations.ts';
const read = p => readFile(new URL('../'+p,import.meta.url),'utf8');
test('lost write response queries the durable key, never repeats POST',async()=>{
 let posts=0,queries=0;const result=await runCloudMutation({post:async()=>{posts++;throw new Error('network')},query:async()=>{queries++;return {status:queries<3?'running':'completed',count:2}},wait:async()=>{}});assert.equal(result.count,2);assert.equal(posts,1);assert.equal(queries,3);
});
test('business write failure does not retry or query as a network failure',async()=>{
 let queries=0;await assert.rejects(()=>runCloudMutation({post:async()=>{throw Object.assign(new Error('forbidden'),{statusCode:403})},query:async()=>{queries++;return {status:'completed'}}}));assert.equal(queries,0);
});
test('running and uncertain operations are never presented as success',async()=>{
 let clock=0;await assert.rejects(()=>runCloudMutation({post:async()=>({status:'running'}),query:async()=>({status:'running'}),now:()=>clock,wait:async()=>{clock+=250000}}),/不要新建重复操作/);await assert.rejects(()=>runCloudMutation({post:async()=>({status:'uncertain'}),query:async()=>({status:'completed'})}),/未确认/);
});
test('operation polling can abort without replaying its write',async()=>{
 const control=new AbortController();control.abort();await assert.rejects(()=>operationWait(control.signal),e=>e.name==='AbortError');
});
test('cloud tools reuse shadcn overlay, fixed footer and inline errors',async()=>{
 const page=await read('components/admin/CloudDriveWorkbench.vue');for(const token of ['AdminDialog','admin-dialog-form','admin-form-fields','modal-actions','role="alert"','confirmationToken','keyFor','onBeforeUnmount'])assert.ok(page.includes(token),token);assert.ok(!page.includes('v-html'));
});
test('resource cloud delete requires server preview, confirmation and durable key',async()=>{
 const page=await read('components/admin/AdminResourcesPage.vue');assert.match(page,/readCloud\('delete-preview'/);assert.match(page,/confirmationToken/);assert.match(page,/deleteRequests/);assert.match(page,/mutateCloud/);assert.match(page,/CloudDriveWorkbench/);
});
