-- Read persisted counts, then exclude only the inactive resource set through
-- its partial index. Visibility changes take effect without rebuilding counts.
WITH inactive_counts AS (
 SELECT refs.channel_id,count(*) n
 FROM managed_resources r
 JOIN channel_resource_references refs ON refs.resource_id=r.id
 WHERE (NOT r.enabled OR r.deleted_at IS NOT NULL) AND refs.channel_id=ANY($1)
 GROUP BY refs.channel_id
)
SELECT c.id,COALESCE(s.failed_count,0) failed_count,
 COALESCE(s.parsed_resource_count,0)-COALESCE(hidden.n,0) resource_count
FROM crawl_channels c
LEFT JOIN channel_statistics s ON s.channel_id=c.id
LEFT JOIN inactive_counts hidden ON hidden.channel_id=c.id
WHERE c.id=ANY($1);
