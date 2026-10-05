import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

test('search limits keep the session, while a genuine 401 refreshes it', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(root, '.tmp/search-limit-'));
  try {
    const output = await build({
      entryPoints: [join(root, 'composables/useSearch.ts')],
      bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false,
    });
    const modulePath = join(directory, 'useSearch.mjs');
    await writeFile(modulePath, output.outputFiles[0].contents);
    const { useSearch } = await import(pathToFileURL(modulePath).href);
    for (const [status, code, expectedRefreshes] of [
      [429, 'SEARCH_LIMIT_EXCEEDED', 0],
      [401, 'SEARCH_LIMIT_EXCEEDED', 0], // Older servers during deployment.
      [401, 'SESSION_REQUIRED', 1],
    ]) {
      const mockedFetch = t.mock.method(globalThis, 'fetch', async () => Response.json(
        { code, statusCode: status, message: 'server reason' }, { status },
      ));
      let search;
      let refreshes = 0;
      await renderToString(createSSRApp({ setup() { search = useSearch(); return () => null; } }));
      await search.performSearch({ apiBase: '/api', keyword: 'test', onSessionExpired() { refreshes++; } });
      assert.equal(search.error.value, 'server reason');
      assert.equal(search.loading.value, false);
      assert.equal(refreshes, expectedRefreshes, `${status} ${code}`);
      assert.equal(mockedFetch.mock.callCount(), 1, 'A rejected search must not retry automatically');
      mockedFetch.mock.restore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
