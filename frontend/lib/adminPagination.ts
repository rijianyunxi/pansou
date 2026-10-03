export function adminPaginationFilters(query: Record<string, unknown>) {
  const page = typeof query.page === 'string' ? Number(query.page) : 1;
  const pageSize = typeof query.pageSize === 'string' ? Number(query.pageSize) : 20;
  return {
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1,
    pageSize: [10, 20, 50].includes(pageSize) ? pageSize : 20,
  };
}
