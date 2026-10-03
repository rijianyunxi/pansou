-- Run only against an isolated database containing representative copies of
-- link_catalog, link_check_jobs and source_messages. All DDL rolls back.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
  RAISE EXCEPTION 'benchmark requires an isolated _test database';
 END IF;
END $$;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
-- Accept copies made before or after 028. Reconstruct the pre-migration
-- indexes inside this transaction; ROLLBACK restores the starting schema.
DROP INDEX IF EXISTS link_check_admin_status;
DROP INDEX IF EXISTS link_check_link_history;
DROP INDEX IF EXISTS link_catalog_failed_links;
CREATE INDEX IF NOT EXISTS idx_messages_recent ON source_messages(channel_id,message_id DESC);
ANALYZE link_catalog;
ANALYZE link_check_jobs;
ANALYZE source_messages;
\echo old_count
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT count(*) FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id;
\echo new_count
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT count(*) FROM link_check_jobs;
\echo old_attention
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT j.id,j.created_at FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id
WHERE j.status='failed' OR c.failure_count>0 OR j.status='running' AND j.lease_until<=now()
ORDER BY j.created_at DESC,j.id DESC LIMIT 31;

CREATE INDEX link_check_admin_status ON link_check_jobs(status,created_at DESC,id DESC);
CREATE INDEX link_check_link_history ON link_check_jobs(link_id,created_at DESC,id DESC);
CREATE INDEX link_catalog_failed_links ON link_catalog(provider,id) WHERE failure_count>0;
\echo new_attention
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT * FROM (
 SELECT j.id,j.created_at FROM link_check_jobs j WHERE j.status='failed'
 UNION
 SELECT j.id,j.created_at FROM link_check_jobs j WHERE j.status='running' AND j.lease_until<=now()
 UNION
 SELECT j.id,j.created_at FROM link_catalog c JOIN link_check_jobs j ON j.link_id=c.id WHERE c.failure_count>0
) candidates ORDER BY created_at DESC,id DESC LIMIT 31;
\echo new_attention_count
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT count(*) FROM (
 SELECT j.id,j.created_at FROM link_check_jobs j WHERE j.status='failed'
 UNION
 SELECT j.id,j.created_at FROM link_check_jobs j WHERE j.status='running' AND j.lease_until<=now()
 UNION
 SELECT j.id,j.created_at FROM link_catalog c JOIN link_check_jobs j ON j.link_id=c.id WHERE c.failure_count>0
) candidates;
SELECT indexrelname,pg_size_pretty(pg_relation_size(indexrelid)) size
FROM pg_stat_user_indexes WHERE indexrelname IN
 ('link_check_admin_status','link_check_link_history','link_catalog_failed_links');

SELECT channel_id ch FROM source_messages GROUP BY channel_id ORDER BY count(*) DESC LIMIT 1 \gset
CREATE TEMP TABLE message_page_before AS
 SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version
 FROM source_messages WHERE channel_id=:'ch' ORDER BY message_id DESC LIMIT 30 OFFSET 20000;
\echo messages_before
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version
FROM source_messages WHERE channel_id=:'ch' ORDER BY message_id DESC LIMIT 30 OFFSET 20000;
DROP INDEX idx_messages_recent;
\echo messages_after
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version
FROM source_messages WHERE channel_id=:'ch' ORDER BY message_id DESC LIMIT 30 OFFSET 20000;
\echo messages_filtered_after
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version
FROM source_messages WHERE channel_id=:'ch' AND parse_status='failed' ORDER BY message_id DESC LIMIT 30;
SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY message_id DESC) FROM message_page_before m)
 IS NOT DISTINCT FROM
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY message_id DESC) FROM (
  SELECT channel_id,message_id,published_at,parse_status,parse_error,parse_version
  FROM source_messages WHERE channel_id=:'ch' ORDER BY message_id DESC LIMIT 30 OFFSET 20000
 ) m) AS message_page_unchanged;
ROLLBACK;
