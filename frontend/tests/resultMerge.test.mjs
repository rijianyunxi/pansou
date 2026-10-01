import test from 'node:test';
import assert from 'node:assert/strict';
import { linkIdentity, mergeResultsByLink } from '../utils/resultMerge.ts';
import { canOpenLink, usable, resolveLink } from '../utils/linkResolution.ts';
const result=(id,keys)=>({id,resultRef:'ref-'+id,dedupKey:[...keys].sort().join(':'),name:id,description:null,datetime:null,cloud_types:['quark'],links:keys.map(linkKey=>({linkKey,linkRef:id+'-'+linkKey,type:'quark',validity:-1}))});
test('opaque link identity is used without URL',()=>assert.equal(linkIdentity({linkKey:'abc'}),'abc'));
test('identical sets merge and keep a complete capability snapshot',()=>{
 const a=result('a',['x','y']), b=result('b',['y','x']);
 const merged=mergeResultsByLink([a,b]);
 assert.equal(merged.length,1); assert.equal(merged[0].id,'a'); assert.equal(merged[0].resultRef,'ref-b');
 assert.ok(merged[0].links.every(l=>l.linkRef.startsWith('b-')));
});
test('partially overlapping collections do not absorb resources',()=>assert.equal(mergeResultsByLink([result('a',['x']),result('b',['x','y']),result('c',['y'])]).length,3));
test('unsafe protocols and expired links cannot open',()=>{
 assert.equal(canOpenLink('javascript:alert(1)'),false);assert.equal(canOpenLink('https://example.test/a'),true);
 assert.equal(usable({status:'unavailable',url:'https://example.test'}),false);
 assert.equal(usable({status:'completed',url:'https://example.test',deliveryExpiresAt:'2000-01-01'}),false);
 assert.equal(usable({status:'completed',url:'https://example.test',shareExpiresAt:'2000-01-01'}),false);
});
test('unavailable is a successful terminal response',async()=>{
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({data:{status:'unavailable',validity:0}})}};
 try {const out=await resolveLink('r','l','key',new AbortController().signal);assert.equal(out.status,'unavailable');assert.equal(calls,1);}finally{globalThis.fetch=old;}
});
