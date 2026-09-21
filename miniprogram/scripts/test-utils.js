// Smoke tests for the pure logic modules (run with node; no wx dependency).
const assert = require('assert');
const { createSseParser, createTextDecoder, buildSearchBody } = require('../utils/searchStream');
const { mergeResultsByLink, canonicalLinkUrl, flattenResultsForDisplay } = require('../utils/resultMerge');
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

// --- resultMerge: shared-link union across URL spelling differences ----------
const merged = mergeResultsByLink([
  {
    id: 'r1', name: 'A', description: '', datetime: null,
    cloud_types: ['baidu'],
    links: [{ type: 'baidu', url: 'https://Pan.Baidu.com/s/1abc#frag/', password: null }],
  },
  {
    id: 'r2', name: 'B', description: 'desc from B', datetime: '2025/09/18 21:30',
    cloud_types: ['quark', 'baidu'],
    links: [{ type: 'baidu', url: 'https://pan.baidu.com/s/1abc', password: 'x9k2' }],
  },
  {
    id: 'r3', name: 'C', description: null, datetime: null,
    cloud_types: ['magnet'],
    links: [{ type: 'magnet', url: 'magnet:?xt=urn:btih:xyz', password: null }],
  },
]);
assert.strictEqual(merged.length, 2);
const first = merged.find((r) => r.id === 'r1');
assert.deepStrictEqual(first.cloud_types.sort(), ['baidu', 'quark']);
assert.strictEqual(first.links.length, 1);
assert.strictEqual(first.links[0].password, 'x9k2');
assert.strictEqual(first.description, 'desc from B');
assert.strictEqual(first.datetime, '2025/09/18 21:30');
assert.strictEqual(canonicalLinkUrl('HTTPS://Example.COM/Path//?a=1#h'), 'https://example.com/Path?a=1');
const display = flattenResultsForDisplay(merged);
assert.strictEqual(display.length, 2);
assert.strictEqual(display[0].links.length, 1);
assert.strictEqual(display[0].sourceId, 'r1');
assert.deepStrictEqual(sortCloudTypes(['others', 'baidu', 'guangya', 'quark']), ['quark', 'baidu', 'others', 'guangya']);
console.log('resultMerge OK');

// --- format: explicit +08:00 date parsing ------------------------------------
assert.ok(parseSearchDate('2025/09/18 21:30') > 0);
assert.strictEqual(parseSearchDate(''), 0);
assert.ok(parseSearchDate('2025-09-18') > 0);
console.log('format OK');

console.log('ALL TESTS PASSED');
