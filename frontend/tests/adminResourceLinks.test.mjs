import test from 'node:test';
import assert from 'node:assert/strict';
import {linkObservation,resourceLinkUrl} from '../lib/adminResourceLinks.ts';
test('link observations distinguish unknown, expired, valid and invalid independently',()=>{
 const base={type:'quark',url:'https://pan.quark.cn/s/example'};
 assert.equal(linkObservation(base).label,'未检测');
 assert.equal(linkObservation({...base,validity:1}).label,'有效');
 assert.equal(linkObservation({...base,validity:0}).label,'失效');
 assert.equal(linkObservation({...base,validity:1,stale:true}).label,'待复检');
 assert.equal(linkObservation({...base,validity:-1,lastAttemptAt:'2026-10-03'}).label,'待确认');
});
test('admin links only open HTTP destinations',()=>{
 assert.equal(resourceLinkUrl('javascript:alert(1)'),undefined);
 assert.equal(resourceLinkUrl('not a link'),undefined);
 assert.equal(resourceLinkUrl('https://pan.quark.cn/s/example'),'https://pan.quark.cn/s/example');
});
