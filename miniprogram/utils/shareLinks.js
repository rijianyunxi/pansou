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
function clipboardText(value) {
  return guangyaBrowserUrl(value) || value.url + (value.password ? '\n提取码：' + value.password : '');
}
module.exports = { guangyaBrowserUrl, clipboardText };
