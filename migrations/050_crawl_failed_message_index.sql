-- Live failure totals and per-channel counts should only scan unresolved tasks.
CREATE INDEX idx_crawl_tasks_failed ON crawl_message_tasks (channel_id)
WHERE status = 'failed';
