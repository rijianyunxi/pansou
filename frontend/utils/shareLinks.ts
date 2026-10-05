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
  return pwdBrowserUrl(value, 'pan.xunlei.com');
}

/** Baidu also accepts pwd, so clipboard text can be pasted directly into an address bar. */
export function baiduBrowserUrl(value: { url?: string; password?: string | null }): string | undefined {
  return pwdBrowserUrl(value, 'pan.baidu.com');
}

/** Quark's share web client reads pwd and passes it as passcode to the share API. */
export function quarkBrowserUrl(value: { url?: string; password?: string | null }): string | undefined {
  return pwdBrowserUrl(value, 'pan.quark.cn');
}

function pwdBrowserUrl(value: { url?: string; password?: string | null }, hostname: string): string | undefined {
  if (!value.url) return;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.hostname !== hostname
      || url.username || url.password || url.port
      || !/^\/s\/[\w-]+\/?$/.test(url.pathname)) return;
    if (value.password) url.searchParams.set('pwd', value.password);
    return url.toString();
  } catch { return; }
}
