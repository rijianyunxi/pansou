import test from 'node:test';
import assert from 'node:assert/strict';
import { linkIdentity, mergeResultsByLink } from '../utils/resultMerge.ts';
const result=(id,urls)=>({id,name:id,description:null,datetime:null,cloud_types:['quark'],links:urls.map(url=>({url,type:'quark',password:null}))});
test('mobile share fragments are separate identities',()=>{
 assert.notEqual(linkIdentity({url:'https://yun.139.com/shareweb/#/w/i/a'}),linkIdentity({url:'https://yun.139.com/shareweb/#/w/i/b'}));
});
test('password and tracking do not change share identity',()=>{
 assert.equal(linkIdentity({url:'https://pan.quark.cn/s/a?pwd=AB12&utm_source=tg'}),linkIdentity({url:'https://pan.quark.cn/s/a'}));
});
test('identical unordered share sets merge and preserve passwords',()=>{
 const a=result('a',['https://pan.quark.cn/s/a','https://pan.baidu.com/s/b']);
 const b=result('b',['https://pan.baidu.com/s/b','https://pan.quark.cn/s/a']);
 b.links[1].password='AB12';
 const merged=mergeResultsByLink([a,b]);
 assert.equal(merged.length,1);assert.equal(merged[0].id,'a');assert.equal(merged[0].links[0].password,'AB12');
});
test('partially overlapping resource sets never absorb each other',()=>{
 const a=result('a',['https://pan.quark.cn/s/a']);
 const b=result('b',['https://pan.quark.cn/s/a','https://pan.quark.cn/s/b']);
 const c=result('c',['https://pan.quark.cn/s/b']);
 assert.equal(mergeResultsByLink([a,b,c]).length,3);
});

test('local-first batches keep the collected title and merge later live duplicates',()=>{
 const local=result('local',['https://pan.quark.cn/s/shared']);
 local.name='采集标题';
 const other=result('other',['https://pan.quark.cn/s/other']);
 const live=result('live',['https://pan.quark.cn/s/shared?pwd=AB12']);
 live.name='外部标题';live.links[0].password='AB12';
 const first=mergeResultsByLink([local]);
 const merged=mergeResultsByLink([...first,other,live,live]);
 assert.equal(merged.length,2);
 assert.deepEqual(merged.map(item=>item.id),['local','other']);
 assert.equal(merged[0].name,'采集标题');
 assert.equal(merged[0].links[0].password,'AB12');
});
