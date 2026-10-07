import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { runInNewContext } from 'node:vm';
const row = i => ({ id: `id-${i}`, name: `名称${i}`, description: '简介', resultRef: `ref-${i}`, dedupKey: `key-${i}`, links: [{ type: 'quark', linkKey: `link-${i}`, linkRef: `link-ref-${i}` }], cloud_types: ['quark'] });
const page = (start, count, nextCursor) => Response.json({ code: 0, data: { results: Array.from({length: count}, (_, i) => row(start+i)), total: count, pageSize: 50, hasMore: Boolean(nextCursor), nextCursor, searchLogId: 9, searchContext:'context' } });
async function withSearch(fn) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(root, '.tmp/search-pages-'));
  let search;
  try {
    const output = await build({ entryPoints: [join(root, 'composables/useSearch.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
    const path = join(directory,'search.mjs'); await writeFile(path, output.outputFiles[0].contents);
    const { useSearch } = await import(pathToFileURL(path).href);
    await renderToString(createSSRApp({ setup() { search = useSearch(); return () => null; } }));
    await fn(search);
  } finally { search?.resetSearch(); await rm(directory,{recursive:true,force:true}); }
}
function timers(t) {
  const pending=new Map(); let id=0;
  t.mock.method(globalThis,'setTimeout',(fn,delay)=>{pending.set(++id,{fn,delay});return id;});
  t.mock.method(globalThis,'clearTimeout',id=>pending.delete(id));
  return {pending,async fire(){assert.equal(pending.size,1);const [id,{fn}]=pending.entries().next().value;pending.delete(id);fn();await settle();}};
}
async function settle(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}
test('four automatic 50-row batches retain submitted scope and stop at 200 even if a server offers more',async t=>{
  const clock=timers(t);const bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(JSON.parse(init.body));return page((bodies.length-1)*50,50,`next-${bodies.length}`);});
  await withSearch(async search=>{
    const options={apiBase:'/api',keyword:'第一页'};await search.performSearch(options);
    assert.equal(search.results.value.length,50);assert.equal(search.state.value.loading,true);assert.equal(bodies.length,1);
    assert.ok([...clock.pending.values()][0].delay>0&&[...clock.pending.values()][0].delay<=500);
    options.keyword='表单已改动';await clock.fire();await clock.fire();await clock.fire();
    assert.equal(search.results.value.length,200);assert.equal(bodies.length,4);assert.equal(clock.pending.size,0);assert.equal(search.state.value.loading,false);assert.equal(search.state.value.hasMore,false);
    assert.deepEqual(bodies,[{kw:'第一页'},{kw:'第一页',cursor:'next-1',searchContext:'context'},{kw:'第一页',cursor:'next-2',searchContext:'context'},{kw:'第一页',cursor:'next-3',searchContext:'context'}]);
  });
});
test('a short final batch stops immediately and provider switches only filter loaded results',async t=>{
  const clock=timers(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>++calls===1?page(0,50,'next'):page(50,23,null));
  await withSearch(async search=>{
    await search.performSearch({apiBase:'/api',keyword:'电影'});await search.selectPlatform('mobile');assert.equal(calls,1);assert.equal(search.results.value.length,50);assert.equal(clock.pending.size,1);
    await clock.fire();assert.equal(search.results.value.length,73);assert.equal(search.state.value.platform,'mobile');assert.equal(search.state.value.loading,false);assert.equal(clock.pending.size,0);
    await search.selectPlatform('all');await search.selectPlatform('quark');await search.loadMore();assert.equal(calls,2);assert.equal(search.results.value.length,73);
  });
});
test('empty and single-page results do not schedule a probe request',async t=>{
  const clock=timers(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>page(0,++calls===1?0:17,null));
  await withSearch(async search=>{await search.performSearch({apiBase:'/api',keyword:'空'});assert.equal(clock.pending.size,0);assert.equal(search.state.value.loading,false);await search.performSearch({apiBase:'/api',keyword:'少'});assert.equal(search.results.value.length,17);assert.equal(clock.pending.size,0);});
});
test('waiting batches can be paused and resumed from the next cursor; reset cancels the timer',async t=>{
  const clock=timers(t);const bodies=[];t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(JSON.parse(init.body));return page((bodies.length-1)*50,50,`next-${bodies.length}`);});
  await withSearch(async search=>{
    await search.performSearch({apiBase:'/api',keyword:'电影'});search.pauseSearch();assert.equal(clock.pending.size,0);assert.equal(search.state.value.paused,true);
    await search.continueSearch();assert.equal(bodies[1].cursor,'next-1');assert.equal(search.results.value.length,100);assert.equal(clock.pending.size,1);
    search.resetSearch();assert.equal(clock.pending.size,0);assert.equal(search.results.value.length,0);
  });
});
test('failed automatic continuation preserves rows and cursor for an explicit retry',async t=>{
  const clock=timers(t);const bodies=[];const responses=[page(0,50,'next'),Response.json({message:'temporary failure'},{status:503}),page(50,2,null)];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{bodies.push(JSON.parse(init.body));return responses.shift();});
  await withSearch(async search=>{await search.performSearch({apiBase:'/api',keyword:'电影'});await clock.fire();assert.equal(clock.pending.size,0);assert.equal(search.results.value.length,50);assert.equal(search.state.value.nextCursor,'next');assert.match(search.error.value,/temporary failure/);await search.loadMore();assert.equal(search.results.value.length,52);assert.equal(search.error.value,'');assert.equal(bodies[2].cursor,'next');});
});
test('slow requests do not overlap and stale batches cannot affect a new search',async t=>{
  const clock=timers(t);let calls=0;let finish;
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)return page(0,50,'next');if(calls===2)return new Promise(resolve=>{finish=resolve;});return page(90,1,null);});
  await withSearch(async search=>{
    await search.performSearch({apiBase:'/api',keyword:'旧'});await clock.fire();assert.equal(clock.pending.size,0);assert.equal(calls,2);
    await search.selectPlatform('mobile');assert.equal(calls,2);assert.equal(search.state.value.loading,true);
    await search.performSearch({apiBase:'/api',keyword:'新'});finish(page(50,50,'stale'));await settle();assert.equal(search.results.value.length,1);assert.equal(search.results.value[0].id,'id-90');assert.equal(clock.pending.size,0);
  });
});
test('SSE pagination automatically continues and legacy live SSE completes without a timer',async t=>{
  const clock=timers(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(`event: start\ndata: {"searchLogId":9}\n\nevent: result\ndata: ${JSON.stringify({results:[row(calls)]})}\n\nevent: complete\ndata: ${JSON.stringify({total:1,hasMore:calls===1,nextCursor:calls===1?'next':null})}\n\n`,{headers:{'content-type':'text/event-stream'}});});
  await withSearch(async search=>{await search.performSearch({apiBase:'/api',keyword:'电影'});await clock.fire();assert.equal(search.results.value.length,2);assert.equal(clock.pending.size,0);await search.performSearch({apiBase:'/api',keyword:'实时'});assert.equal(clock.pending.size,0);});
});
async function mini() {
  const miniMerge=(await import('../../miniprogram/utils/resultMerge.js')).default;
  const clouds=(await import('../../miniprogram/utils/cloudTypes.js')).default;
  const format=(await import('../../miniprogram/utils/format.js')).default;
  let definition;const requests=[];const pending=new Map();let id=0;
  runInNewContext(await readFile(new URL('../../miniprogram/pages/index/index.js',import.meta.url),'utf8'),{
    wx:{},console,Date,setTimeout:(fn,delay)=>{pending.set(++id,{fn,delay});return id;},clearTimeout:id=>pending.delete(id),setInterval,clearInterval,
    require(path){if(path.endsWith('/theme'))return {themedPage:d=>{definition=d;}};if(path.endsWith('/searchStream'))return {searchStream:o=>{requests.push(o);return {abort(){}};}};if(path.endsWith('/searchHistory'))return {createHistory:()=>({read:()=>[]})};if(path.endsWith('/resultMerge'))return miniMerge;if(path.endsWith('/cloudTypes'))return clouds;if(path.endsWith('/format'))return format;if(path.endsWith('/config'))return {DEFAULT_HOME_SEARCH_PLACEHOLDER:'搜索'};return {};},
  });
  const component={...definition,data:{...definition.data,loading:true},_searchSeq:1,_snapshot:{keyword:'电影'},_merged:[],_filterPlatform:'all',_accumulated:0,setData(v){Object.assign(this.data,v);},startTimer(){},stopTimer(){},scheduleFlush(){},loadSessionFlags(){}};
  return {component,requests,pending,fire(){assert.equal(pending.size,1);const [id,{fn}]=pending.entries().next().value;pending.delete(id);fn();},complete(start,count,next){const req=requests.at(-1);req.onUpdate({results:Array.from({length:count},(_,i)=>row(start+i))});req.onComplete({hasMore:!!next,nextCursor:next,searchContext:'context'});}};
}
test('mini automatically fetches four batches, allows local filtering while loading, and stops at 200',async()=>{
  const m=await mini();m.component.runSearch();m.complete(0,50,'n1');assert.equal(m.component.data.results.length,50);assert.equal(m.component.data.loading,true);
  m.component.onPillTap({currentTarget:{dataset:{type:'mobile'}}});assert.equal(m.requests.length,1);assert.equal(m.component.data.results.length,0);
  m.fire();assert.equal(m.requests[1].cursor,'n1');assert.equal(m.requests[1].cloudType,undefined);m.complete(50,50,'n2');m.fire();m.complete(100,50,'n3');m.fire();m.complete(150,50,'n4');
  assert.equal(m.pending.size,0);assert.equal(m.requests.length,4);assert.equal(m.component.data.loading,false);m.component.onPillTap({currentTarget:{dataset:{type:'all'}}});assert.equal(m.component.data.results.length,200);assert.equal(m.component.data.hasMore,false);
});
test('mini pauses the waiting timer, resumes the right cursor, and stops early on a short batch',async()=>{
  const m=await mini();m.component.runSearch();m.complete(0,50,'next');m.component.onPause();assert.equal(m.pending.size,0);assert.equal(m.component.data.paused,true);m.component.continueSearch();assert.equal(m.requests[1].cursor,'next');m.complete(50,7,null);assert.equal(m.pending.size,0);assert.equal(m.component.data.results.length,57);assert.equal(m.component.data.hasMore,false);m.component.onReset();assert.equal(m.component._nextCursor,null);
});
const wireRow=i=>({resultRef:`ref-${i}`,dedupKey:`key-${i}`,name:`资源${i}`,description:'简介',datetime:'2026-10-07',links:[{type:'quark',linkRef:`link-ref-${i}`}]});
const sseEvent=(event,data)=>new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
test('one SSE request renders four compact batches and provider switching never starts another request',async t=>{
  const clock=timers(t);let stream;let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;assert.equal(init.headers.Accept,'text/event-stream');return new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'content-type':'text/event-stream'}});});
  await withSearch(async search=>{
    const pending=search.performSearch({apiBase:'/api',keyword:'电影'});await settle();
    stream.enqueue(sseEvent('start',{searchLogId:9,searchContext:'context',intervalMs:500}));
    stream.enqueue(sseEvent('result',{results:Array.from({length:50},(_,i)=>wireRow(i)),nextCursor:'n1'}));await settle();
    assert.equal(search.results.value.length,50);assert.equal(search.results.value[0].id,'key-0');assert.deepEqual(search.results.value[0].cloud_types,['quark']);assert.equal(search.results.value[0].links[0].linkKey,'link-ref-0');
    await search.selectPlatform('mobile');assert.equal(search.state.value.loading,true);assert.equal(calls,1);assert.equal(clock.pending.size,0);
    for(let start=50;start<200;start+=50)stream.enqueue(sseEvent('result',{results:Array.from({length:50},(_,i)=>wireRow(start+i)),nextCursor:start===150?null:`n${start}`}));
    stream.enqueue(sseEvent('complete',{total:200}));stream.close();await pending;
    assert.equal(search.results.value.length,200);assert.equal(search.state.value.loading,false);assert.equal(search.state.value.hasMore,false);assert.equal(calls,1);assert.equal(clock.pending.size,0);
  });
});
test('paused SSE resumes from the latest successful batch rather than retransmitting earlier rows',async t=>{
  const clock=timers(t);let stream;const bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    bodies.push(JSON.parse(init.body));
    if(bodies.length===1){init.signal.addEventListener('abort',()=>stream.close());return new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'content-type':'text/event-stream'}});}
    return new Response(new ReadableStream({start(c){c.enqueue(sseEvent('start',{searchContext:'context'}));c.enqueue(sseEvent('result',{results:Array.from({length:25},(_,i)=>wireRow(50+i)),nextCursor:null}));c.enqueue(sseEvent('complete',{total:75}));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  });
  await withSearch(async search=>{
    const pending=search.performSearch({apiBase:'/api',keyword:'电影'});await settle();stream.enqueue(sseEvent('start',{searchContext:'context'}));stream.enqueue(sseEvent('result',{results:Array.from({length:50},(_,i)=>wireRow(i)),nextCursor:'checkpoint'}));await settle();
    search.pauseSearch();await pending;assert.equal(search.state.value.paused,true);await search.continueSearch();
    assert.deepEqual(bodies[1],{kw:'电影',cursor:'checkpoint',searchContext:'context'});assert.equal(search.results.value.length,75);assert.equal(clock.pending.size,0);
  });
});
test('mini consumes compact SSE batches in one request and saves the current resume checkpoint',async()=>{
  const m=await mini();m.component.runSearch();m.requests[0].onStart({searchContext:'context'});m.requests[0].onUpdate({results:Array.from({length:50},(_,i)=>wireRow(i)),nextCursor:'checkpoint'});m.component.flush();
  assert.equal(m.component.data.results.length,50);assert.equal(m.component._activeCursor,'checkpoint');m.component.onPillTap({currentTarget:{dataset:{type:'quark'}}});assert.equal(m.requests.length,1);
  m.requests[0].onUpdate({results:Array.from({length:23},(_,i)=>wireRow(50+i)),nextCursor:null});m.requests[0].onComplete({total:73});assert.equal(m.component.data.results.length,73);assert.equal(m.component.data.loading,false);assert.equal(m.pending.size,0);assert.equal(m.requests.length,1);
});
