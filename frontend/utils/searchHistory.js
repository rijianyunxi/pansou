const KEY = 'pansou.search-history.v1';
const LIMIT = 20;
/** @param {unknown} value @returns {string[]} */
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
/** @param {Pick<Storage, "getItem" | "setItem" | "removeItem">} storage */
function createHistory(storage) {
  function read() { try { return normalize(JSON.parse(storage.getItem(KEY) || '[]')); } catch (_) { return []; } }
  /** @param {string[]} items */
  function save(items) { const value = normalize(items); storage.setItem(KEY, JSON.stringify(value)); return value; }
  return {
    read,
    /** @param {string} term */
    add(term) { if (typeof term !== 'string' || !term.trim() || term.trim().length > 100) return read(); return save([term.trim(), ...read()]); },
    /** @param {string} term */
    remove(term) { return save(read().filter(item => item !== term)); },
    clear() { storage.removeItem(KEY); return []; },
  };
}
export { createHistory, normalize };
