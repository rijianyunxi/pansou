import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import { useToast } from '../composables/useToast.ts';
import * as linkActions from '../utils/linkActions.ts';
import { usable } from '../utils/linkResolution.ts';

const available = { status: 'completed', validity: 1, url: 'https://example.test/share', password: '1234' };
const resource = { resultRef: 'result', name: '测试资源' };
const link = { linkRef: 'link' };

async function setupCard({ resolve = async () => available, copy = async () => {}, crypto = { randomUUID: () => 'test-key' } } = {}) {
  const source = await readFile(new URL('../components/ResultGroup.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'link-feedback-test' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const feedback = useToast();
  const messages = [];
  const showToast = (...args) => { messages.push(args); return feedback.showToast(...args); };
  const hooks = [];
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, closed: false,
    location: { replace(url) { popup.url = url; } }, close() { popup.closed = true; } };
  const require = name => {
    if (name === 'vue') return { ...vue, inject: () => showToast, onBeforeUnmount: hook => hooks.push(hook) };
    if (name.includes('linkActions')) return linkActions;
    if (name.includes('linkResolution')) return { resolveLink: resolve, usable };
    return {};
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'navigator', 'ClipboardItem', 'crypto', compiled)(
    require, module, module.exports, { open: () => popup }, { clipboard: { writeText: copy } }, undefined, crypto,
  );
  const component = module.exports.default.setup({ items: [], expanded: true, platformLabel: () => '夸克网盘' }, { expose() {}, emit() {} });
  return { component, feedback, messages, popup, unmount() { hooks.forEach(hook => hook()); },
    cleanup() { hooks.forEach(hook => hook()); feedback.hideToast(); } };
}

test('modal waits for actual clipboard success and does not show duplicate toasts', async () => {
  let finishResolve,finishCopy,startCopy;const copying=new Promise(r=>startCopy=r);
  const card=await setupCard({resolve:()=>new Promise(r=>finishResolve=r),copy:()=>new Promise(r=>{finishCopy=r;startCopy();})});
  try {const pending=card.component.act('copy',resource,link);assert.equal(card.component.dialog.value.status,'loading');assert.equal(card.messages.length,0);finishResolve(available);await copying;assert.equal(card.component.dialog.value.status,'loading');finishCopy();await pending;assert.equal(card.component.dialog.value.status,'success');assert.equal(card.component.copiedKey.value,'link');assert.equal(card.component.loading.link,undefined);}finally{card.cleanup();}
});
test('open prepares an in-page ready state without opening a blank tab',async()=>{
  let finish;const card=await setupCard({resolve:()=>new Promise(r=>finish=r)});
  try {const pending=card.component.act('open',resource,link);assert.equal(card.component.dialog.value.status,'loading');finish(available);await pending;assert.equal(card.component.dialog.value.status,'ready');assert.equal(card.component.dialog.value.url,available.url);assert.equal(card.popup.url,undefined);assert.equal(card.messages.length,0);}finally{card.cleanup();}
});
test('a denied clipboard retry reuses the ready link instead of resolving or writing again',async()=>{
  let resolves=0,copies=0;const card=await setupCard({resolve:async()=>{resolves++;return available;},copy:async()=>{if(++copies===1)throw new DOMException('Denied','NotAllowedError');}});
  try {await card.component.act('copy',resource,link);assert.equal(card.component.dialog.value.status,'error');assert.match(card.component.dialog.value.message,/复制/);await card.component.retryDialog();assert.equal(card.component.dialog.value.status,'success');assert.equal(resolves,1);assert.equal(copies,2);}finally{card.cleanup();}
});
test('invalid results do not offer retry or copy, and no backend terminology is surfaced',async()=>{
  const card=await setupCard({resolve:async()=>({status:'unavailable',validity:0,reasonCode:'resource_missing'})});
  try {await card.component.act('copy',resource,link);assert.equal(card.component.dialog.value.status,'error');assert.equal(card.component.dialog.value.retryable,false);assert.equal(card.component.copiedKey.value,'');assert.match(card.component.dialog.value.message,/资源已不存在/);}finally{card.cleanup();}
});
test('a ready link is rechecked for expiry before the browser can follow it',async()=>{
  const card=await setupCard();let prevented=false;
  try {await card.component.act('open',resource,link);card.component.resolved.link.deliveryExpiresAt='2000-01-01';card.component.openReady({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(card.component.dialog.value.status,'error');}finally{delete available.deliveryExpiresAt;card.cleanup();}
});
test('closing pending UI stops polling, blocks duplicate clicks and retains the idempotency key for resume',async()=>{
  const calls=[];const card=await setupCard({resolve:(_r,_l,key,signal,resume)=>{calls.push({key,resume});if(resume)return Promise.resolve(available);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('停止')),{once:true}));}});
  try {const pending=card.component.act('copy',resource,link);await card.component.act('copy',resource,link);assert.equal(calls.length,1);card.component.closeDialog();await pending;assert.equal(card.component.dialog.value,null);await card.component.act('copy',resource,link);assert.equal(calls.length,2);assert.equal(calls[1].key,calls[0].key);assert.equal(calls[1].resume,true);assert.equal(card.component.dialog.value.status,'success');}finally{card.cleanup();}
});
test('unmount discards pending actions without success feedback',async()=>{
  const card=await setupCard({resolve:(_r,_l,_k,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('停止')),{once:true}))});
  try {const pending=card.component.act('copy',resource,link);card.unmount();await pending;assert.equal(card.component.dialog.value,null);assert.equal(card.component.copiedKey.value,'');assert.equal(card.messages.length,0);}finally{card.cleanup();}
});
test('copying a displayed password uses no additional link request',async()=>{
  let calls=0;const copied=[];const card=await setupCard({resolve:async()=>{calls++;return available;},copy:async text=>copied.push(text)});
  try {await card.component.act('copy',resource,link);await card.component.copyPassword('link');assert.equal(calls,1);assert.deepEqual(copied,[available.url,available.password]);assert.equal(card.feedback.toast.value.message,'提取码已复制');}finally{card.cleanup();}
});
