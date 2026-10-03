-- Bounded lock acquisition: retry the migration if active writers prevent DDL.
SET LOCAL lock_timeout='5s';

-- State filtering and the failed/running attention branches. Keep the existing
-- created_at index for unfiltered pages and the worker's due/lease indexes.
CREATE INDEX link_check_admin_status ON link_check_jobs(status,created_at DESC,id DESC);
-- Attention includes historical and reshared jobs, not only active originals.
CREATE INDEX link_check_link_history ON link_check_jobs(link_id,created_at DESC,id DESC);
-- Unlike the recent-error index, this must include failures without error text.
CREATE INDEX link_catalog_failed_links ON link_catalog(provider,id) WHERE failure_count>0;

-- All message-list sorts fix channel_id first. The primary key supports the
-- same message_id DESC ordering via a backward scan; status queries retain
-- idx_crawl_messages_status. No global mixed-direction sort needs this index.
DROP INDEX idx_messages_recent;
