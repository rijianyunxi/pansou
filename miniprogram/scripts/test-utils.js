// Smoke tests for the pure logic modules (run with node; no wx dependency).
const assert = require('assert');
const { createSseParser, createTextDecoder, buildSearchBody } = require('../utils/searchStream');
const { mergeResultsByLink, flattenResultsForDisplay } = require('../utils/resultMerge');
const { sortCloudTypes } = require('../utils/cloudTypes');
const { parseSearchDate } = require('../utils/format');

// --- SSE parser: events split across chunk boundaries -----------------------
const events = [];
const parser = createSseParser((event) => events.push(event));
const stream = [
  'id: 1\nevent: start\ndata: {"code":0,"mess',
  'age":"started","data":{"intervalMs":16}}\n\n',
  'event: result\ndata: {"results":[{"id":"a","name":"标题","links":[]}]}\n\n',
  'event: complete\ndata: {"code":0,"message":"success"}\n\n',
];
for (const chunk of stream) parser.feed(chunk);
parser.flush();
assert.strictEqual(events.length, 3);
assert.strictEqual(events[0].event, 'start');
assert.strictEqual(JSON.parse(events[0].data).data.intervalMs, 16);
assert.strictEqual(events[1].event, 'result');
assert.strictEqual(JSON.parse(events[1].data).results[0].name, '标题');
assert.strictEqual(events[2].event, 'complete');
console.log('SSE parser OK');

// --- Search request body: never send an empty custom-channel list -----------
assert.deepStrictEqual(buildSearchBody('兰香如故', []), { kw: '兰香如故' });
assert.deepStrictEqual(buildSearchBody('兰香如故', ['movie_channel']), {
  kw: '兰香如故',
  channels: ['movie_channel'],
});
console.log('Search body OK');

// --- UTF-8 decoder: multibyte char split across chunk boundary ---------------
function runDecoder(chunks) {
  const decoder = createTextDecoder();
  return chunks.map((bytes) => decoder.decode(Uint8Array.from(bytes), false)).join('')
    + decoder.decode(Uint8Array.from([]), true);
}
const text = '网盘资源 abc 123 🔍 end';
const bytes = Array.from(Buffer.from(text, 'utf8'));
// Split after every byte offset around the first CJK char and an emoji (4 bytes).
for (const cut of [3, 4, 5, 9, 12, 16, bytes.indexOf(0xf0) + 1, bytes.indexOf(0xf0) + 2]) {
  const decoded = runDecoder([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.strictEqual(decoded, text, `split at ${cut}: ${JSON.stringify(decoded)}`);
}
assert.strictEqual(runDecoder([bytes]), text);
console.log('UTF-8 streaming decoder OK');

// --- v2: opaque complete-set dedup, never join partially overlapping collections ---
const result = (id, keys) => ({ id, name: id, resultRef: 'ref-' + id, dedupKey: keys.slice().sort().join(':'), cloud_types: ['quark'], links: keys.map(k => ({linkKey:k,linkRef:id+'-'+k,type:'quark'})) });
const merged = mergeResultsByLink([result('a',['x','y']), result('b',['y','x'])]);
assert.strictEqual(merged.length,1);
assert.strictEqual(merged[0].resultRef,'ref-b');
assert.ok(merged[0].links.every(l=>l.linkRef.startsWith('b-')));
assert.strictEqual(mergeResultsByLink([result('a',['x']),result('b',['x','y']),result('c',['y'])]).length,3);
assert.strictEqual(flattenResultsForDisplay(merged).length,2);
const { usable, uuid } = require('../utils/linkResolution');
assert.ok(/^[0-9a-f-]{36}$/.test(uuid()));
assert.ok(!usable({status:'unavailable'}));
assert.ok(!usable({status:'completed',url:'javascript:alert(1)'}));
assert.ok(!usable({status:'completed',url:'https://example.test',deliveryExpiresAt:'2000-01-01'}));
console.log('v2 link identity and delivery safety OK');

// --- format: explicit +08:00 date parsing ------------------------------------
assert.ok(parseSearchDate('2025/09/18 21:30') > 0);
assert.strictEqual(parseSearchDate(''), 0);
assert.ok(parseSearchDate('2025-09-18') > 0);
console.log('format OK');

console.log('ALL TESTS PASSED');
