import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

/**
 * A link pasted out of a chat message, or a Markdown `[标题](url)`, used to be
 * stored verbatim: it passed the protocol check and the resource then rendered a
 * URL nobody could open. These cases pin the guard that rejects it.
 */
const directory = mkdtempSync(join(tmpdir(), 'panhub-links-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'links.sqlite');

const jiti = createJiti(import.meta.url);
const { createManagedResource } = await jiti.import('../server/core/services/managedResourceService.ts');

const resource = (url, type = 'aliyun') => ({ name: '示例资源', links: [{ type, url }] });

test('managed resource links', async (t) => {
  await t.test('a plain link is accepted unchanged', () => {
    const created = createManagedResource(resource('https://www.alipan.com/s/ABC123'));

    assert.equal(created.links[0].url, 'https://www.alipan.com/s/ABC123');
  });

  await t.test('a Markdown-wrapped link is rejected', () => {
    assert.throws(
      () => createManagedResource(resource('https://www.alipan.com/s/ABC123](https://www.alipan.com/s/ABC123')),
      /第二个链接/,
    );
  });

  await t.test('a link copied with trailing text is rejected', () => {
    assert.throws(
      () => createManagedResource(resource('https://www.alipan.com/s/ABC123 提取码：abcd')),
      /空格或引号/,
    );
    assert.throws(
      () => createManagedResource(resource('https://www.alipan.com/s/AB"C123')),
      /空格或引号/,
    );
  });

  await t.test('an unsupported protocol is still rejected first', () => {
    assert.throws(() => createManagedResource(resource('javascript:alert(1)')), /协议不支持/);
  });

  await t.test('magnet links and bracketed IPv6 hosts are not over-rejected', () => {
    const magnet = createManagedResource(resource('magnet:?xt=urn:btih:ABCDEF0123456789', 'magnet'));
    assert.equal(magnet.links[0].url, 'magnet:?xt=urn:btih:ABCDEF0123456789');

    // Square brackets are legal in a URL (IPv6 literals); the guard must not
    // reject them just because it rejects the Markdown case.
    const ipv6 = createManagedResource(resource('http://[2001:db8::1]:8080/share'));
    assert.equal(ipv6.links[0].url, 'http://[2001:db8::1]:8080/share');
  });
});
