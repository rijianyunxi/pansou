-- Bulk message retries queue several single-walk retry jobs for one channel;
-- sync/backfill keep the one-active-job guarantee.
DROP INDEX idx_crawl_job_active;
CREATE UNIQUE INDEX idx_crawl_job_active ON crawl_jobs(channel_id,kind)
 WHERE status IN ('queued','running','paused') AND kind<>'retry';
