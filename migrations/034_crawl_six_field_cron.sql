-- One-time upgrade of stored values; runtime accepts only six-field cron.
UPDATE crawl_settings SET daily_cron=CASE
 WHEN daily_cron IS NULL THEN '0 */10 * * * *'
 WHEN cardinality(regexp_split_to_array(trim(daily_cron),'\s+'))=5 THEN '0 '||daily_cron
 ELSE daily_cron END,version=version+1;
ALTER TABLE crawl_settings ALTER COLUMN daily_cron SET NOT NULL;
ALTER TABLE crawl_settings ALTER COLUMN daily_cron SET DEFAULT '0 */10 * * * *';
ALTER TABLE crawl_settings ADD CONSTRAINT crawl_settings_six_field_cron
 CHECK(cardinality(regexp_split_to_array(trim(daily_cron),'\s+'))=6);
ALTER TABLE crawl_settings DROP COLUMN daily_interval_seconds;
