WITH cursor AS MATERIALIZED (
 SELECT * FROM link_check_enqueue_cursors WHERE provider=$1 FOR UPDATE SKIP LOCKED
), due AS MATERIALIZED (
 -- Separate cursor/no-cursor paths allow the composite B-tree to seek directly.
 SELECT batch.* FROM cursor s CROSS JOIN LATERAL (
  (SELECT c.id,c.input_version,c.next_check_at FROM resource_links c
   WHERE c.provider=s.provider AND s.next_check_at IS NULL AND c.next_check_at<=now()
   ORDER BY c.next_check_at,c.id LIMIT 256)
  UNION ALL
  (SELECT c.id,c.input_version,c.next_check_at FROM resource_links c
   WHERE c.provider=s.provider AND s.next_check_at IS NOT NULL AND c.next_check_at<=now()
    AND (c.next_check_at,c.id)>(s.next_check_at,s.link_id)
   ORDER BY c.next_check_at,c.id LIMIT 256)
 ) batch
), inserted AS (
 INSERT INTO link_check_jobs(link_id,input_version,kind)
 SELECT d.id,d.input_version,'original' FROM due d
 WHERE NOT EXISTS(SELECT 1 FROM link_check_jobs j WHERE j.link_id=d.id
  AND j.input_version=d.input_version AND j.kind='original' AND j.status IN('queued','running'))
 ON CONFLICT DO NOTHING RETURNING id
), tail AS (
 SELECT next_check_at,id FROM due ORDER BY next_check_at DESC,id DESC LIMIT 1
)
UPDATE link_check_enqueue_cursors s SET
 next_check_at=CASE WHEN (SELECT count(*) FROM due)=256 THEN (SELECT next_check_at FROM tail) END,
 link_id=CASE WHEN (SELECT count(*) FROM due)=256 THEN (SELECT id FROM tail) END
WHERE s.provider=(SELECT provider FROM cursor);
