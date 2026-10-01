-- Run with psql against an already migrated disposable database ending _test.
-- Fixture data and the temporary legacy index are rolled back at the end.
\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database() NOT LIKE '%\_test' THEN
 RAISE EXCEPTION 'Only disposable _test databases are allowed'; END IF; END $$;
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL max_parallel_workers_per_gather=0;
CREATE INDEX link_check_due ON link_check_jobs(run_after,priority,id) WHERE status IN('queued','running');
INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at,last_seen_at)
 SELECT gen_random_uuid(),'quark','queue-benchmark-'||i,'https://pan.quark.cn/s/benchmark'||i,
 'queue-benchmark-'||i,now()-interval '1 day',now()-make_interval(secs=>i)
 FROM generate_series(1,250000) i;
INSERT INTO link_check_jobs(link_id,input_version,kind,priority)
 SELECT id,1,'original',1 FROM link_catalog WHERE identity LIKE 'queue-benchmark-%';
INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at)
 SELECT gen_random_uuid(),'quark','future-benchmark-'||i,'https://pan.quark.cn/s/future'||i,
 'future-benchmark-'||i,now()+interval '1 day' FROM generate_series(1,100000) i;
INSERT INTO link_check_jobs(link_id,input_version,kind,priority)
 SELECT id,1,'original',10 FROM link_catalog WHERE identity LIKE 'future-benchmark-%';
ANALYZE link_catalog;
ANALYZE link_check_jobs;
-- A scalar diagnostic replacement for the old account EXISTS: no real credentials.
PREPARE old_claim(uuid) AS
 UPDATE link_check_jobs SET status='running',lease_token=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1
 WHERE id=(SELECT j.id FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id
  WHERE j.kind='original' AND c.provider='quark' AND c.next_check_at<=now()
   AND ((j.status='queued' AND j.run_after<=now()) OR (j.status='running' AND j.lease_until<now()))
  ORDER BY j.priority DESC,c.last_seen_at DESC,j.run_after,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1)
 RETURNING id,link_id,input_version;
PREPARE new_claim(text[],uuid) AS
\ir ../src/link_resolution/claim_check.sql
PREPARE enqueue(text) AS
\ir ../src/link_resolution/enqueue_checks.sql
SAVEPOINT measurement;
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE old_claim('00000000-0000-0000-0000-000000000001');
ROLLBACK TO measurement;
-- Test the new path with the deployed index set, not with the retired old index.
DROP INDEX link_check_due;
RELEASE measurement;
SAVEPOINT measurement;
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE new_claim(ARRAY['quark'],'00000000-0000-0000-0000-000000000001');
ROLLBACK TO measurement;
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE old_claim('00000000-0000-0000-0000-000000000001');
ROLLBACK TO measurement;
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE new_claim(ARRAY['quark'],'00000000-0000-0000-0000-000000000001');
ROLLBACK TO measurement;
-- All inspected links are already queued: this is the old enqueue's worst case.
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE enqueue('quark');
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE enqueue('quark');
-- Future high-priority jobs must not turn the claim into a full queue scan.
-- The 100,000 future urgent jobs were present during every claim above.
-- The empty provider path also must be a short index probe, not a scan.
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF) EXECUTE new_claim(ARRAY['baidu'],'00000000-0000-0000-0000-000000000001');
ROLLBACK;
