-- External results and retired resource links live only while their tasks/artifacts need them.
WITH candidates AS MATERIALIZED (
 SELECT c.id FROM resource_links c WHERE resource_id IS NULL AND created_at<now()-interval '1 hour'
 AND NOT EXISTS(SELECT 1 FROM link_share_cache s WHERE s.link_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM link_resolve_requests r WHERE r.link_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM link_check_jobs j WHERE j.link_id=c.id)
 ORDER BY c.created_at,c.id LIMIT 1000 FOR UPDATE OF c SKIP LOCKED
)
DELETE FROM resource_links c USING candidates d WHERE c.id=d.id;
