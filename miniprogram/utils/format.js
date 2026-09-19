/** Date parsing and sorting, ported from pages/index/index.vue. */

/**
 * Search dates are formatted server-side in Asia/Shanghai, so parse that
 * explicit offset instead of relying on device-local time parsing.
 */
function parseSearchDate(value) {
  const raw = (value || '').trim();
  if (!raw) return 0;
  const match = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    const hour = (match[4] || '00').padStart(2, '0');
    const minute = match[5] || '00';
    const second = match[6] || '00';
    const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortResults(items, sortType) {
  const arr = items.slice();
  if (sortType === 'default') return arr;
  return sortType === 'date-asc'
    ? arr.sort((a, b) => parseSearchDate(a.datetime) - parseSearchDate(b.datetime))
    : arr.sort((a, b) => parseSearchDate(b.datetime) - parseSearchDate(a.datetime));
}

module.exports = { parseSearchDate, sortResults };
