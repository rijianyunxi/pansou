-- A second worker cannot hold two page-fetch leases for the same channel.
CREATE UNIQUE INDEX idx_crawl_one_running_channel ON crawl_jobs(channel_id) WHERE status='running';
