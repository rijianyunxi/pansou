-- One indexed candidate per provider/priority; at most six rows are briefly locked.
-- The exact global best due job is among these candidates. Future jobs and accounts
-- without credentials do not force a walk through the active queue.
WITH candidates AS MATERIALIZED (
 SELECT job.id,level.priority,job.run_after
 FROM unnest($1::text[]) AS p(provider)
 CROSS JOIN (VALUES(10),(1),(0)) AS level(priority)
 CROSS JOIN LATERAL (
  SELECT j.id,j.run_after FROM link_check_jobs j
  WHERE j.provider=p.provider AND j.priority=level.priority
   AND j.kind='original' AND j.status='queued' AND j.run_after<=now()
  ORDER BY j.run_after,j.id LIMIT 1 FOR UPDATE SKIP LOCKED
 ) job
), winner AS (
 SELECT id FROM candidates ORDER BY priority DESC,run_after,id LIMIT 1
)
UPDATE link_check_jobs j SET status='running',lease_token=$2,
 lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now()
FROM winner WHERE j.id=winner.id RETURNING j.id,j.link_id,j.input_version;
