import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminPageCursors } from '../lib/adminPageCursors.ts';

test('visited pages use cursors; unvisited jumps retain page numbers', () => {
  const pages = new AdminPageCursors();
  assert.deepEqual(pages.query(1, 20, ['query']), { page: 1, pageSize: 20, before: undefined });
  pages.remember(1, 'anchor-2');
  assert.equal(pages.query(2, 20, ['query']).before, 'anchor-2');
  assert.equal(pages.query(50, 20, ['query']).before, undefined);
  pages.remember(50, 'anchor-51');
  assert.equal(pages.query(51, 20, ['query']).before, 'anchor-51');
  assert.equal(pages.query(2, 20, ['query']).before, 'anchor-2');
});

test('filter/size changes and edits discard old anchors', () => {
  const pages = new AdminPageCursors();
  pages.query(1, 20, ['one', 'quark']); pages.remember(1, 'old');
  assert.equal(pages.query(2, 20, ['two', 'quark']).before, undefined);
  pages.remember(1, 'new');
  assert.equal(pages.query(2, 50, ['two', 'quark']).before, undefined);
  pages.remember(1, 'size'); pages.clear();
  assert.equal(pages.query(2, 50, ['two', 'quark']).before, undefined);
});

test('refreshing an earlier page invalidates later anchors and the terminal page clears continuation', () => {
  const pages = new AdminPageCursors();
  pages.query(1, 20, []); pages.remember(1, 'two'); pages.remember(2, 'three');
  pages.remember(1, 'refreshed-two');
  assert.equal(pages.query(2, 20, []).before, 'refreshed-two');
  assert.equal(pages.query(3, 20, []).before, undefined);
  pages.remember(1, null);
  assert.equal(pages.query(2, 20, []).before, undefined);
});
