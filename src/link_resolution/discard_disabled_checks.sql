-- Bound cleanup work and serialize it with the check switch, without touching
-- in-flight or interactive jobs. The catalog sweep recreates background work.
WITH setting AS MATERIALIZED (
 SELECT COALESCE((value_json->>'enabled')::boolean,false) enabled
 FROM policy_settings WHERE key='link-check' FOR SHARE
), discarded AS MATERIALIZED (
 SELECT j.id FROM link_check_jobs j CROSS JOIN setting s
 WHERE NOT s.enabled AND j.kind='original' AND j.status='queued' AND j.priority<10
 ORDER BY j.id LIMIT 1000 FOR UPDATE OF j SKIP LOCKED
), removed AS (
 DELETE FROM link_check_jobs j USING discarded d WHERE j.id=d.id RETURNING j.id
)
UPDATE link_check_enqueue_cursors SET next_check_at=NULL,link_id=NULL
WHERE EXISTS(SELECT 1 FROM removed);
