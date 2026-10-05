// WeChat's JS runtime does not provide the browser URL API.
function guangyaBrowserUrl(value) {
  const match = /^https?:\/\/(guangyapan\.com|www\.guangyapan\.com)\/s\/([\w-]+)\/?(\?[^#\s]*)?(?:#[^\s]*)?$/i.exec(value.url || '');
  if (!match) return null;
  let query = match[3] || '';
  const pairs = query.slice(1).split('&').filter(Boolean);
  const storedCode = pairs.find(pair => pair.startsWith('code='));
  let code = value.password;
  if (!code && storedCode) {
    try { code = decodeURIComponent(storedCode.slice(storedCode.indexOf('=') + 1).replace(/\+/g, ' ')); }
    catch (_) { return null; }
  }
  if (code) {
    const kept = pairs.filter(pair => !pair.startsWith('code='));
    kept.push('code=' + encodeURIComponent(code));
    query = '?' + kept.join('&');
  }
  return 'https://' + match[1].toLowerCase() + '/s/' + match[2] + query + '#/share';
}
function pwdBrowserUrl(value) {
  const match = /^(https?:\/\/pan\.(?:(?:xunlei|baidu)\.com|quark\.cn)\/s\/[\w-]+\/?)(\?[^#\s]*)?(#[^\s]*)?$/i.exec(value.url || '');
  if (!match) return null;
  let query = match[2] || '';
  if (value.password) {
    const pairs = query.slice(1).split('&').filter(Boolean);
    const kept = pairs.filter(pair => {
      try { return decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' ')) !== 'pwd'; }
      catch (_) { return true; }
    });
    kept.push('pwd=' + encodeURIComponent(value.password));
    query = '?' + kept.join('&');
  }
  return match[1] + query + (match[3] || '');
}
function clipboardText(value) {
  // 提取码单独展示和复制，避免地址栏把说明文字当成 URL 的一部分。
  return guangyaBrowserUrl(value) || pwdBrowserUrl(value) || value.url;
}
module.exports = { guangyaBrowserUrl, clipboardText };
