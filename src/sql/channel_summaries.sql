WITH selected AS MATERIALIZED (SELECT id FROM crawl_channels WHERE id=ANY($1)),
message_counts AS (
 SELECT m.channel_id,count(*) message_count
 FROM source_messages m WHERE m.channel_id=ANY($1) GROUP BY m.channel_id
),resource_counts AS (
 SELECT o.channel_id,count(DISTINCT o.resource_id COLLATE "C") resource_count
 FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id)
 WHERE o.channel_id=ANY($1) AND m.parse_status='parsed'
 AND NOT EXISTS(SELECT 1 FROM managed_resources r WHERE r.id=o.resource_id AND (NOT r.enabled OR r.deleted_at IS NOT NULL))
 GROUP BY o.channel_id
)
SELECT c.id,COALESCE(m.message_count,0) message_count,
 COALESCE(r.resource_count,0) resource_count
FROM selected c LEFT JOIN message_counts m ON m.channel_id=c.id LEFT JOIN resource_counts r ON r.channel_id=c.id;
