-- Read-only checks against the local development database after migrations.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL max_parallel_workers_per_gather=0;
PREPARE channel_counts(text[]) AS
\ir ../src/sql/channel_summaries.sql
SELECT array_agg(id)::text AS channel_ids FROM crawl_channels \gset
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE channel_counts(:'channel_ids');
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
 SELECT cloud_type,resource_count FROM resource_cloud_type_counts ORDER BY cloud_type;
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF)
 SELECT candidate.id,level.priority,candidate.run_after
 FROM (VALUES('baidu'),('quark')) p(provider)
 CROSS JOIN (VALUES(10),(1),(0)) level(priority)
 CROSS JOIN LATERAL (
  SELECT j.id,j.run_after FROM link_check_jobs j WHERE j.provider=p.provider
   AND j.priority=level.priority AND j.kind='original' AND j.status='queued'
   AND j.run_after<=now() ORDER BY j.run_after,j.id LIMIT 1
 ) candidate ORDER BY level.priority DESC,candidate.run_after,candidate.id LIMIT 1;
ROLLBACK;
