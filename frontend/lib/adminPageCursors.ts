/** Keep continuation anchors for visited pages while retaining direct page jumps. */
export class AdminPageCursors {
  private signature = '';
  private anchors = new Map<number, string>();

  clear() { this.signature = ''; this.anchors.clear(); }

  query(page: number, pageSize: number, filters: unknown[]) {
    const signature = JSON.stringify([pageSize, filters]);
    if (signature !== this.signature) {
      this.anchors.clear();
      this.signature = signature;
    }
    return { page, pageSize, before: page > 1 ? this.anchors.get(page) : undefined };
  }

  remember(page: number, nextCursor: unknown) {
    // Refreshing an earlier page invalidates anchors derived from its old rows.
    for (const key of this.anchors.keys()) if (key > page) this.anchors.delete(key);
    if (typeof nextCursor === 'string' && nextCursor) {
      if (this.anchors.size >= 256) this.anchors.delete(this.anchors.keys().next().value!);
      this.anchors.set(page + 1, nextCursor);
    }
  }
}
