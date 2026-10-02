import type { ResolvedLink } from '../shared/apiModels';
import { usable } from './linkResolution.ts';

export type LinkAction = 'open' | 'copy';
interface LinkActionEffects {
  prepareOpen: () => { navigate: (url: string) => void; close: () => void };
  copy: (text: Promise<string>) => Promise<void>;
  invalid: (value: ResolvedLink) => void;
  failed: (message: string) => void;
}
export function invalidLink(value?: ResolvedLink): boolean {
  return value?.status === 'unavailable' || value?.validity === 0;
}
export function invalidReason(value?: ResolvedLink): string {
  return value?.reasonCode === 'resource_missing' ? '分享中的资源已不存在' : '原分享链接已失效';
}
function clipboardText(value: ResolvedLink): string {
  if (!usable(value) || invalidLink(value)) throw new Error('链接已失效');
  return value.url + (value.password ? '\n提取码：' + value.password : '');
}

/** Both actions resolve the same capability; only the final side effect differs. */
export async function executeLinkAction(action: LinkAction, resolve: () => Promise<ResolvedLink>, effects: LinkActionEffects) {
  let destination: ReturnType<LinkActionEffects['prepareOpen']> | undefined;
  try {
    // Reserve the new tab/clipboard operation during the original click gesture.
    if (action === 'open') destination = effects.prepareOpen();
    const pending = resolve();
    const text = pending.then(clipboardText);
    void text.catch(() => {});
    const copying = action === 'copy' ? effects.copy(text) : undefined;
    // Observe rejection immediately, even when resolve fails before copying settles.
    void copying?.catch(() => {});
    const value = await pending;
    if (invalidLink(value)) {
      destination?.close();
      effects.invalid(value);
      return value;
    }
    if (!usable(value)) throw new Error('未获取到可用链接，请稍后重试');
    if (action === 'open') destination!.navigate(value.url);
    else await copying;
    return value;
  } catch (error) {
    destination?.close();
    effects.failed(error instanceof Error ? error.message : '操作失败，请稍后重试');
  }
}
