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
  while (!signal.aborted && Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(poll ? `/api/links/resolve-operations/${requestKey}` : '/api/links/resolve', {
        method: poll ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'Content-Type': 'application/json' },
        ...(poll ? {} : { body: JSON.stringify({ resultRef, linkRef, requestKey }) }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      poll = true; // A lost POST response does not authorize another write.
      await delay(signal); continue;
    }
    const body = await response.json();
    if (!response.ok) throw new Error([401,403,409,410].includes(response.status)
      ? '会话、资源或链接已变化，请重新搜索' : (body.message || '获取失败，请稍后重试'));
    const data = body.data as ResolvedLink;
    if (response.status === 200 && ['completed','unavailable'].includes(data.status)) return data;
    onProgress?.(data);
    poll = true; await delay(signal, data.pollAfterMs);
  }
  throw new Error('等待超时，可继续查询本次操作');
}
function delay(signal: AbortSignal, interval = 1500) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('已停止查询')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(500, Math.min(3000, interval || 1500)));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
