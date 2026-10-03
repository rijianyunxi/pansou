-- Match stable log ordering and tuple cursors; supersede the timestamp-only index.
SET LOCAL lock_timeout = '5s';
CREATE INDEX idx_search_logs_page ON search_logs(created_at DESC,id DESC);
DROP INDEX idx_search_logs_created_at;
