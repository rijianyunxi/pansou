import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory as webHistory } from '../utils/searchHistory.js';
import mini from '../../miniprogram/utils/searchHistory.js';
for (const [name, factory] of [['web', webHistory], ['mini', mini.createHistory]]) {
  test(`${name}: history persists, deduplicates, bounds and removes records`, () => {
    const data = new Map();
    const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
    const history = factory(storage);
    assert.deepEqual(history.read(), []);
    history.add('  宇宙  '); history.add('电影'); history.add('宇宙');
    assert.deepEqual(factory(storage).read(), ['宇宙', '电影']);
    history.add('BBC'); history.add('bbc');
    assert.deepEqual(history.read().slice(0,3), ['bbc','宇宙','电影']);
    for (let i=0;i<25;i++) history.add(`term${i}`);
    assert.equal(history.read().length,20);
    assert.equal(history.read()[0],'term24');
    history.add('  '); history.add('x'.repeat(101));
    assert.equal(history.read().length,20);
    history.remove('term24'); assert.equal(history.read()[0],'term23');
    history.clear(); assert.deepEqual(factory(storage).read(),[]);
    data.set('pansou.search-history.v1','{broken'); assert.deepEqual(history.read(),[]);
    data.set('pansou.search-history.v1',JSON.stringify([null,{},' a ','a',12]));
    assert.deepEqual(history.read(),['a']);
  });
  test(`${name}: unavailable storage is handled on read and surfaced on write`, () => {
    const h=factory({getItem(){throw Error('denied')},setItem(){throw Error('full')},removeItem(){throw Error('denied')}});
    assert.deepEqual(h.read(),[]); assert.throws(()=>h.add('test'),/full/); assert.throws(()=>h.clear(),/denied/);
  });
}

test('mini: accepted searches record history, reset retains it, sorting and back-top work', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  let definition; let scrolled;
  const storage = new Map();
  const wx = { getStorageSync:k=>storage.get(k), setStorageSync:(k,v)=>storage.set(k,v), removeStorageSync:k=>storage.delete(k), pageScrollTo:o=>{scrolled=o;} };
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/index/index.js',import.meta.url),'utf8'), {
    wx, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require(path) {
      if(path.endsWith('/searchHistory')) return mini;
      if(path.endsWith('/theme')) return {themedPage:d=>{definition=d;}};
      if(path.endsWith('/feedback')) return {showToast(){}};
      if(path.endsWith('/config')) return {DEFAULT_HOME_SEARCH_PLACEHOLDER:'搜索'};
      return {};
    }
  });
  const page={...definition, data:{...definition.data},setData(v){Object.assign(this.data,v);},runSearch(){},loadSessionFlags(){},flush(){this.flushed=true;}};
  page.startSearch('  宇宙  ');
  assert.equal(page.data.searchHistory[0],'宇宙');
  page.onReset(); assert.equal(page.data.searchHistory[0],'宇宙'); assert.equal(page.data.searched,false);
  page.data.scope='channels'; page.startSearch('未配置频道'); assert.equal(page.data.searchHistory.length,1);
  page.data.scope='site'; page.onHotTap({currentTarget:{dataset:{term:'电影'}}}); assert.equal(page.data.searchHistory[0],'电影');
  page.data.loading=false; page.onSortTap({currentTarget:{dataset:{index:2}}}); assert.equal(page.data.sortIndex,2); assert.equal(page.flushed,true);
  page.onPageScroll({scrollTop:500}); assert.equal(page.data.showBackTop,true);
  page.onBackTop(); assert.equal(scrolled.scrollTop,0);
  page.onPageScroll({scrollTop:0}); assert.equal(page.data.showBackTop,false);
});
