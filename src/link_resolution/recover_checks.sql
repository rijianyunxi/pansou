-- A crash is retried with a fresh token; the old owner's completion is fenced out.
WITH expired AS (
 SELECT id FROM link_check_jobs WHERE kind='original' AND status='running'
  AND lease_until<now() ORDER BY lease_until,id LIMIT 100 FOR UPDATE SKIP LOCKED
)
UPDATE link_check_jobs j SET status='queued',lease_token=NULL,lease_until=NULL,updated_at=now()
FROM expired WHERE j.id=expired.id;
