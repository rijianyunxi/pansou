const KEY = 'pansou.search-history.v1';
const LIMIT = 20;
function normalize(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(term => {
    if (typeof term !== 'string' || !term.trim() || term.trim().length > 100) return false;
    const key = term.trim().toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(term => term.trim()).slice(0, LIMIT);
}
function createHistory(storage) {
  function read() { try { return normalize(JSON.parse(storage.getItem(KEY) || '[]')); } catch (_) { return []; } }
  function save(items) { const value = normalize(items); storage.setItem(KEY, JSON.stringify(value)); return value; }
  return {
    read,
    add(term) { if (typeof term !== 'string' || !term.trim() || term.trim().length > 100) return read(); return save([term.trim(), ...read()]); },
    remove(term) { return save(read().filter(item => item !== term)); },
    clear() { storage.removeItem(KEY); return []; },
  };
}
module.exports = { createHistory, normalize };
