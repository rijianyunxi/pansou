-- NULL retains the existing interval schedule until cron is explicitly selected.
ALTER TABLE crawl_settings ADD COLUMN daily_cron TEXT
 CHECK(daily_cron IS NULL OR length(daily_cron) BETWEEN 1 AND 200);
ALTER TABLE crawl_settings ALTER COLUMN daily_interval_seconds SET DEFAULT 600;

-- Transactional notifications wake every worker after a committed change.
-- Row triggers do not notify on empty scheduler updates, avoiding a wakeup loop.
CREATE FUNCTION notify_crawl_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('pansou_crawl_wakeup','');
 RETURN NULL;
END;
$$;
CREATE TRIGGER crawl_channels_wakeup AFTER INSERT OR DELETE OR
 UPDATE OF enabled,next_sync_at,next_page_at,history_complete,history_cursor ON crawl_channels
 FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();
CREATE TRIGGER crawl_jobs_wakeup AFTER INSERT OR DELETE OR
 UPDATE OF status,next_run_at,lease_until ON crawl_jobs
 FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();
CREATE TRIGGER crawl_settings_wakeup AFTER UPDATE ON crawl_settings
 FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();
CREATE TRIGGER crawl_switch_wakeup AFTER INSERT OR UPDATE OR DELETE ON policy_settings
 FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();
