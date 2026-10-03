-- psql: resource candidate-query observation; no production writes.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,updated_at FROM managed_resources WHERE deleted_at IS NULL
ORDER BY updated_at DESC,id DESC LIMIT 21 OFFSET 20000;
SELECT id,updated_at FROM managed_resources WHERE deleted_at IS NULL
ORDER BY updated_at DESC,id DESC LIMIT 1 OFFSET 19999
\gset anchor_
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,updated_at FROM managed_resources WHERE deleted_at IS NULL
AND (updated_at,id)<(:'anchor_updated_at'::timestamptz,:'anchor_id')
ORDER BY updated_at DESC,id DESC LIMIT 21;
ROLLBACK;

-- Synthetic log observation: disposable _test database only; everything rolls back.
BEGIN;
DO $$ BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
  RAISE EXCEPTION 'Synthetic log benchmark requires a disposable _test database';
 END IF;
END $$;
CREATE TEMP TABLE log_page_benchmark(id bigint PRIMARY KEY,created_at timestamptz NOT NULL);
INSERT INTO log_page_benchmark
SELECT i,'2026-01-01'::timestamptz+(i/5)*interval '1 second' FROM generate_series(1,200000) i;
CREATE INDEX log_old_page ON log_page_benchmark(created_at DESC);
ANALYZE log_page_benchmark;
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,created_at FROM log_page_benchmark ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET 100000;
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,created_at FROM log_page_benchmark
WHERE (created_at,id)<('2026-01-01 05:33:20+00',100000)
ORDER BY created_at DESC,id DESC LIMIT 21;
CREATE INDEX log_new_page ON log_page_benchmark(created_at DESC,id DESC);
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,created_at FROM log_page_benchmark
WHERE (created_at,id)<('2026-01-01 05:33:20+00',100000)
ORDER BY created_at DESC,id DESC LIMIT 21;
ROLLBACK;
