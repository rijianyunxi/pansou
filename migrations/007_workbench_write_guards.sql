-- Workbench write concurrency and durable enqueue idempotency.
ALTER TABLE source_template_settings ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE crawl_jobs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX idx_crawl_job_request_key ON crawl_jobs(channel_id,request_key) WHERE request_key IS NOT NULL;
