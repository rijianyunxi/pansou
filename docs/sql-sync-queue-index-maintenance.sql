-- One-time maintenance, separate from schema migrations. Run with psql against
-- the intended database; do NOT wrap REINDEX CONCURRENTLY in a transaction.
-- If interrupted, inspect pg_index.indisvalid before retrying or removing any
-- leftover concurrent-build index. These indexes enforce uniqueness/order.
\set ON_ERROR_STOP on
SET lock_timeout='5s';
SET statement_timeout='2min';
SELECT current_database();
SELECT indexrelname,pg_size_pretty(pg_relation_size(indexrelid)) size
FROM pg_stat_user_indexes WHERE relname='link_sync_queue';
REINDEX INDEX CONCURRENTLY public.link_sync_queue_pkey;
REINDEX INDEX CONCURRENTLY public.link_sync_queue_order;
SELECT c.relname,i.indisvalid,i.indisready,pg_size_pretty(pg_relation_size(c.oid)) size
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
WHERE i.indrelid='public.link_sync_queue'::regclass;
RESET lock_timeout;
RESET statement_timeout;
