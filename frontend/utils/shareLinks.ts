/** Guangya accepts its extraction code in the URL, making clipboard text directly navigable. */
export function guangyaBrowserUrl(value: { url?: string; password?: string | null }): string | undefined {
  if (!value.url) return;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol)
      || !['guangyapan.com', 'www.guangyapan.com'].includes(url.hostname)
      || url.username || url.password || url.port
      || !/^\/s\/[\w-]+\/?$/.test(url.pathname)) return;
    url.protocol = 'https:';
    url.pathname = url.pathname.replace(/\/$/, '');
    const code = value.password || url.searchParams.get('code');
    if (code) url.searchParams.set('code', code);
    url.hash = '/share';
    return url.toString();
  } catch { return; }
}

/** Xunlei carries its extraction code in pwd; copying extra prose breaks address-bar pastes. */
export function xunleiBrowserUrl(value: { url?: string; password?: string | null }): string | undefined {
  if (!value.url) return;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.hostname !== 'pan.xunlei.com'
      || url.username || url.password || url.port
      || !/^\/s\/[\w-]+\/?$/.test(url.pathname)) return;
    if (value.password) url.searchParams.set('pwd', value.password);
    return url.toString();
  } catch { return; }
}
