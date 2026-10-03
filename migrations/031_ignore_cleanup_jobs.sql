-- 忽略是阻塞清理任务的出口：不再被 worker 认领，也不计入“需要关注”；
-- 云端产物保持原样，只有手动重试能把任务恢复进队列。
ALTER TABLE link_cleanup_jobs DROP CONSTRAINT link_cleanup_jobs_status_check;
ALTER TABLE link_cleanup_jobs ADD CONSTRAINT link_cleanup_jobs_status_check CHECK(status IN('queued','running','completed','failed','blocked','ignored'));
