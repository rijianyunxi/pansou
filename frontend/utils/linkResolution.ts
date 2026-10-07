import type { ResolvedLink } from '../shared/apiModels';

export function canOpenLink(url?: string): boolean {
  if (!url) return false;
  try { return ['https:', 'http:', 'magnet:'].includes(new URL(url).protocol); } catch { return false; }
}
export function usable(value?: ResolvedLink): value is ResolvedLink & { url: string } {
  return !!value && value.status === 'completed' && canOpenLink(value.url)
    && [value.deliveryExpiresAt, value.shareExpiresAt].every(t => !t || Date.parse(t) > Date.now());
}
export async function resolveLink(resultRef: string, linkRef: string, requestKey: string, signal: AbortSignal, resume = false, onProgress?: (value: ResolvedLink) => void): Promise<ResolvedLink> {
  const deadline = Date.now() + 150000;
  let poll = resume;
  let failures = 0;
  let replayed = false;
  while (!signal.aborted && Date.now() < deadline) {
    let response: Response;
    let body: { data?: ResolvedLink };
    try {
      response = await fetch(poll ? `/api/links/resolve-operations/${requestKey}` : '/api/links/resolve', {
        method: poll ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'Content-Type': 'application/json' },
        ...(poll ? {} : { body: JSON.stringify({ resultRef, linkRef, requestKey }) }),
      });
      if (poll && response.status === 404 && !replayed) {
        // An interrupted submission may never have reached the server. Replaying
        // its SAME idempotency key can recover it without creating a second job.
        replayed = true; poll = false; continue;
      }
      if ([401,403,409,410].includes(response.status)) throw Object.assign(new Error('链接信息已变化，请重新搜索后再试。'), { terminal: true });
      if ([400,404].includes(response.status)) throw Object.assign(new Error('暂时无法获取这个链接，请重新搜索后再试。'), { terminal: true });
      if (!response.ok) throw new Error('temporary');
      body = await response.json();
      if (!body.data || !['processing','completed','unavailable'].includes(body.data.status)) throw Object.assign(new Error('暂时没有获取到链接，请稍后再试。'), { terminal: true });
    } catch (error) {
      if (signal.aborted) throw new Error('已停止查询');
      if ((error as { terminal?: boolean }).terminal) throw error;
      if (++failures >= 4) throw new Error('网络不太稳定，请稍后再试。');
      poll = true;
      await delay(signal, Math.min(5000, 1000 * 2 ** (failures - 1))); continue;
    }
    failures = 0;
    const data = body.data!;
    if (response.status === 200 && ['completed','unavailable'].includes(data.status)) return data;
    onProgress?.(data);
    poll = true; await delay(signal, data.pollAfterMs);
  }
  if (signal.aborted) throw new Error('已停止查询');
  throw new Error('这次等待有些久，点击重试可继续获取。');
}
function delay(signal: AbortSignal, interval = 1500) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('已停止查询')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(500, Math.min(5000, Number.isFinite(interval) ? interval : 1500)));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
